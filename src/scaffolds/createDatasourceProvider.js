import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';
import { loadUserConfig, resolveConfigFile } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';

const createProviderTemplateWithoutDatasource = (providerName, contextPrefix) => `import { createBoundaryProvider } from '@azure-net/kit';

export const ${providerName} = createBoundaryProvider('${contextPrefix}${providerName}', {
\tregister: () => ({})
});
`;

const createProviderTemplateWithDatasource = (providerName, contextPrefix, datasourceName, datasourceImportPath) => {
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

const getCoreAliasOrThrow = async () => {
	const configRef = resolveConfigFile();
	if (!configRef.exists) {
		throw new Error(
			'azure-net.config is not configured. Run "azure-net init folders-structure" and do not forget to fill contexts if you need them.'
		);
	}

	const content = await fs.readFile(configRef.filepath, 'utf-8');
	const aliasMatch = content.match(/coreAlias\s*:\s*['"`]([^'"`]+)['"`]/);
	const alias = aliasMatch?.[1]?.trim();
	if (!alias) {
		throw new Error(
			'azure-net.config is not configured. Run "azure-net init folders-structure" and do not forget to fill contexts if you need them.'
		);
	}

	return alias.startsWith('$') ? alias : `$${alias}`;
};

const getDatasourcesFromPath = async (targetPath) => {
	try {
		const files = await fs.readdir(targetPath);
		return files.filter((file) => file.endsWith('.ts') && file !== 'index.ts').map((file) => file.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

const resolveContextPrefix = (target) => (target === 'core' ? 'Core' : toPascalCase(target));

const resolveProviderPath = (target) => {
	if (target === 'core') {
		return path.join(process.cwd(), 'src', 'core', 'provider');
	}

	return path.join(process.cwd(), 'src', 'app', target, 'layers', 'infrastructure', 'providers');
};

const resolveContextAlias = (contexts, targetContext) => {
	const found = contexts.find((context) => context.name === targetContext);
	if (!found) {
		return `$${targetContext}`;
	}

	return found.alias.startsWith('$') ? found.alias : `$${found.alias}`;
};

const ensureProviderName = (rawName) => {
	const normalized = toPascalCase(rawName || 'DatasourceProvider') || 'DatasourceProvider';
	return normalized.endsWith('Provider') ? normalized : `${normalized}Provider`;
};

export default async function createDatasourceProvider() {
	const { providerNameRaw } = await prompts({
		type: 'text',
		name: 'providerNameRaw',
		message: 'Datasource provider name:',
		initial: 'DatasourceProvider'
	});

	const providerName = ensureProviderName(String(providerNameRaw ?? 'DatasourceProvider'));
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);
	const contextChoices = [{ title: 'core', value: 'core' }, ...contexts.map((context) => ({ title: context.name, value: context.name }))];

	const { target } = await prompts({
		type: 'select',
		name: 'target',
		message: 'Where to create datasource provider?',
		choices: contextChoices,
		initial: 0
	});

	const selectedTarget = String(target ?? 'core');
	const coreDatasources = await getDatasourcesFromPath(path.join(process.cwd(), 'src', 'core', 'datasource'));
	const contextDatasources =
		selectedTarget === 'core'
			? []
			: await getDatasourcesFromPath(
					path.join(process.cwd(), 'src', 'app', selectedTarget, 'layers', 'infrastructure', 'http', 'datasources')
				);

	const datasourceChoices = [{ title: 'No datasource', value: null }];
	for (const datasource of coreDatasources) {
		datasourceChoices.push({ title: `${datasource} (core)`, value: { name: datasource, source: 'core' } });
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

	const selectedDatasource = datasourceSelection ?? null;
	const contextPrefix = resolveContextPrefix(selectedTarget);
	let content;

	if (!selectedDatasource) {
		content = createProviderTemplateWithoutDatasource(providerName, contextPrefix);
	} else {
		const importPath =
			selectedDatasource.source === 'core'
				? `${await getCoreAliasOrThrow()}/datasource`
				: `${resolveContextAlias(contexts, selectedTarget)}/layers/infrastructure/http/datasources`;

		content = createProviderTemplateWithDatasource(providerName, contextPrefix, selectedDatasource.name, importPath);
	}

	const providerPath = resolveProviderPath(selectedTarget);
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
