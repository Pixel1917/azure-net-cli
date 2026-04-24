import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';
import { loadUserConfig, resolveConfigFile } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';

type ContextChoice = { title: string; value: string };

const createDatasourceTemplateWithoutResponse = (
	className: string
): string => `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';

export class ${className} extends BaseHttpDatasource {
\tasync createRequest<T>(callback: CreateRequestCallbackType<T>) {
\t\treturn await this.createRawRequest<T>(callback);
\t}
}
`;

const createDatasourceTemplateWithResponseAndInterface = (
	className: string,
	responseName: string,
	coreAlias: string
): string => `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';
import { ${responseName}, type I${responseName} } from '${coreAlias}/response';

export class ${className} extends BaseHttpDatasource {
\tasync createRequest<T>(callback: CreateRequestCallbackType<I${responseName}<T>>) {
\t\treturn new ${responseName}<T>(await this.createRawRequest<I${responseName}<T>>(callback));
\t}
}
`;

const createDatasourceTemplateWithResponse = (
	className: string,
	responseName: string,
	coreAlias: string
): string => `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';
import { ${responseName} } from '${coreAlias}/response';

export class ${className} extends BaseHttpDatasource {
\tasync createRequest<T>(callback: CreateRequestCallbackType<T>) {
\t\treturn new ${responseName}<T>(await this.createRawRequest<T>(callback));
\t}
}
`;

const ensureDatasourceClassName = (rawName: string): string => {
	const normalized = toPascalCase(rawName || 'MockApi');
	return normalized.endsWith('Datasource') ? normalized : `${normalized}Datasource`;
};

const getContextChoices = async (): Promise<ContextChoice[]> => {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);

	const choices: ContextChoice[] = [{ title: 'core', value: 'core' }];
	for (const context of contexts) {
		choices.push({ title: context.name, value: context.name });
	}

	return choices;
};

const getCoreResponses = async (): Promise<string[]> => {
	const responsesPath = path.join(process.cwd(), 'src', 'core', 'response');
	try {
		const files = await fs.readdir(responsesPath);
		return files.filter((file) => file.endsWith('.ts') && file !== 'index.ts').map((file) => file.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

const hasResponseInterface = async (responseName: string): Promise<boolean> => {
	const responsePath = path.join(process.cwd(), 'src', 'core', 'response', `${responseName}.ts`);
	try {
		const content = await fs.readFile(responsePath, 'utf-8');
		const interfaceRegex = new RegExp(`export\\s+interface\\s+I${responseName}\\b`);
		return interfaceRegex.test(content);
	} catch {
		return false;
	}
};

const getConfiguredCoreAliasOrThrow = async (): Promise<string> => {
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

const resolveTargetPath = (target: string): string => {
	if (target === 'core') {
		return path.join(process.cwd(), 'src', 'core', 'datasource');
	}

	return path.join(process.cwd(), 'src', 'app', target, 'layers', 'infrastructure', 'http', 'datasources');
};

export default async function createDatasource(): Promise<void> {
	const { datasourceNameRaw } = await prompts({
		type: 'text',
		name: 'datasourceNameRaw',
		message: 'Datasource name:',
		initial: 'MockApi'
	});

	const className = ensureDatasourceClassName(String(datasourceNameRaw ?? 'MockApi'));

	const contextChoices = await getContextChoices();
	const { target } = await prompts({
		type: 'select',
		name: 'target',
		message: 'Where to create datasource?',
		choices: contextChoices,
		initial: 0
	});

	const selectedTarget = String(target ?? 'core');
	const coreResponses = await getCoreResponses();

	let selectedResponse: string | null = null;
	if (coreResponses.length > 0) {
		const { responseName } = await prompts({
			type: 'select',
			name: 'responseName',
			message: 'Select response for datasource:',
			choices: [{ title: 'No response', value: null }, ...coreResponses.map((response) => ({ title: response, value: response }))],
			initial: 0
		});
		selectedResponse = responseName ? String(responseName) : null;
	}

	let content: string;
	if (!selectedResponse) {
		content = createDatasourceTemplateWithoutResponse(className);
	} else {
		const coreAlias = await getConfiguredCoreAliasOrThrow();
		const withInterface = await hasResponseInterface(selectedResponse);
		content = withInterface
			? createDatasourceTemplateWithResponseAndInterface(className, selectedResponse, coreAlias)
			: createDatasourceTemplateWithResponse(className, selectedResponse, coreAlias);
	}

	const targetPath = resolveTargetPath(selectedTarget);
	await fs.mkdir(targetPath, { recursive: true });

	const filePath = path.join(targetPath, `${className}.ts`);
	const created = await writeIfNotExists(filePath, content);
	await updateIndexTs(targetPath);

	if (!created) {
		console.log(`⚠️ Datasource "${className}" already exists. File was not overwritten.`);
		return;
	}

	console.log(`✅ Datasource created: ${filePath}`);
}
