import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';
import { loadUserConfig } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';
import { getFoundationConstructImportPath, getFoundationConstructPath, getSharedState } from '../utils/sharedFoundation.js';

type NormalizedContext = { name: string; alias: string };
type DatasourceChoiceValue = null | { name: string; source: 'shared' | 'context' };

const createProviderTemplateWithoutDatasource = (
	providerName: string,
	contextPrefix: string
): string => `import { createBoundaryProvider } from '@azure-net/kit';

export const ${providerName} = createBoundaryProvider('${contextPrefix}${providerName}', {
\tregister: () => ({})
});
`;

const createProviderTemplateWithDatasource = (
	providerName: string,
	contextPrefix: string,
	datasourceName: string,
	datasourceImportPath: string
): string => {
	const factoryNameBase = datasourceName.endsWith('Datasource') ? datasourceName.slice(0, -'Datasource'.length) : datasourceName;
	const datasourceFactoryName = `${factoryNameBase || datasourceName}Rest`;

	return `import { ${datasourceName} } from '${datasourceImportPath}';
import { createHttpServiceInstance } from '@azure-net/kit/infra';
import { createBoundaryProvider } from '@azure-net/kit';

export const ${providerName} = createBoundaryProvider('${contextPrefix}${providerName}', {
\tregister: () => ({
\t\t${datasourceFactoryName}: () =>
\t\t\tnew ${datasourceName}({
\t\t\t\thttp: createHttpServiceInstance({
\t\t\t\t\tprefixUrl: 'https://localhost'
\t\t\t\t})
\t\t\t})
\t})
});
`;
};

const getDatasourcesFromPath = async (targetPath: string): Promise<string[]> => {
	try {
		const files = await fs.readdir(targetPath);
		return files.filter((file) => file.endsWith('.ts') && file !== 'index.ts').map((file) => file.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

const resolveContextPrefix = (target: string): string => (target === '__shared__' ? 'Shared' : toPascalCase(target));

const resolveProviderPath = (target: string): string => {
	if (target === '__shared__') {
		throw new Error('Shared provider path must be resolved async.');
	}

	return path.join(process.cwd(), 'src', 'app', target, 'layers', 'infrastructure', 'providers');
};

const resolveContextAlias = (contexts: NormalizedContext[], targetContext: string): string => {
	const found = contexts.find((context) => context.name === targetContext);
	if (!found) {
		return `$${targetContext}`;
	}

	return found.alias.startsWith('$') ? found.alias : `$${found.alias}`;
};

const ensureProviderName = (rawName: string): string => {
	const normalized = toPascalCase(rawName || 'DatasourceProvider') || 'DatasourceProvider';
	return normalized.endsWith('Provider') ? normalized : `${normalized}Provider`;
};

export default async function createDatasourceProvider(): Promise<void> {
	const { providerNameRaw } = await prompts({
		type: 'text',
		name: 'providerNameRaw',
		message: 'Datasource provider name:',
		initial: 'DatasourceProvider'
	});

	const providerName = ensureProviderName(String(providerNameRaw ?? 'DatasourceProvider'));
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts) as NormalizedContext[];
	const contextChoices = [
		{ title: 'shared foundation', value: '__shared__' },
		...contexts.map((context) => ({ title: context.name, value: context.name }))
	];

	const { target } = await prompts({
		type: 'select',
		name: 'target',
		message: 'Where to create datasource provider?',
		choices: contextChoices,
		initial: 0
	});

	const selectedTarget = String(target ?? '__shared__');
	const { sharedAlias, sharedContext } = await getSharedState();
	const sharedDatasources = await getDatasourcesFromPath(getFoundationConstructPath(sharedContext.name, 'datasource'));
	const contextDatasources =
		selectedTarget === '__shared__'
			? []
			: await getDatasourcesFromPath(
					path.join(process.cwd(), 'src', 'app', selectedTarget, 'layers', 'infrastructure', 'http', 'datasources')
				);

	const datasourceChoices: Array<{ title: string; value: DatasourceChoiceValue }> = [{ title: 'No datasource', value: null }];
	for (const datasource of sharedDatasources) {
		datasourceChoices.push({ title: `${datasource} (shared foundation)`, value: { name: datasource, source: 'shared' } });
	}
	for (const datasource of contextDatasources) {
		datasourceChoices.push({ title: `${datasource} (${selectedTarget})`, value: { name: datasource, source: 'context' } });
	}

	const { datasourceSelection } = await prompts({
		type: 'select',
		name: 'datasourceSelection',
		message: 'Select datasource:',
		choices: datasourceChoices,
		initial: 0
	});

	const selectedDatasource = (datasourceSelection ?? null) as DatasourceChoiceValue;
	const contextPrefix = resolveContextPrefix(selectedTarget);
	let content: string;

	if (!selectedDatasource) {
		content = createProviderTemplateWithoutDatasource(providerName, contextPrefix);
	} else {
		const importPath =
			selectedDatasource.source === 'shared'
				? getFoundationConstructImportPath(sharedAlias, 'datasource')
				: `${resolveContextAlias(contexts, selectedTarget)}/layers/infrastructure/http/datasources`;

		content = createProviderTemplateWithDatasource(providerName, contextPrefix, selectedDatasource.name, importPath);
	}

	const providerPath =
		selectedTarget === '__shared__' ? getFoundationConstructPath(sharedContext.name, 'provider') : resolveProviderPath(selectedTarget);
	await fs.mkdir(providerPath, { recursive: true });

	const filePath = path.join(providerPath, `${providerName}.ts`);
	const created = await writeIfNotExists(filePath, content);
	await updateIndexTs(providerPath);

	if (!created) {
		console.log(`⚠️ Datasource provider "${providerName}" already exists. File was not overwritten.`);
		return;
	}

	console.log(`✅ Datasource provider created: ${filePath}`);
}
