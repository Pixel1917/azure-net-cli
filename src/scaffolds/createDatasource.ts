import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';
import { loadUserConfig } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';
import { getFoundationConstructImportPath, getFoundationConstructPath, getSharedState } from '../utils/sharedFoundation.js';

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
	responseImportPath: string
): string => `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';
import { ${responseName}, type I${responseName} } from '${responseImportPath}';

export class ${className} extends BaseHttpDatasource {
\tasync createRequest<T>(callback: CreateRequestCallbackType<I${responseName}<T>>) {
\t\treturn new ${responseName}<T>(await this.createRawRequest<I${responseName}<T>>(callback));
\t}
}
`;

const createDatasourceTemplateWithResponse = (
	className: string,
	responseName: string,
	responseImportPath: string
): string => `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';
import { ${responseName} } from '${responseImportPath}';

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

	const choices: ContextChoice[] = [{ title: 'shared foundation', value: '__shared__' }];
	for (const context of contexts) {
		choices.push({ title: context.name, value: context.name });
	}

	return choices;
};

const getSharedResponses = async (): Promise<string[]> => {
	const { sharedContext } = await getSharedState();
	const responsesPath = getFoundationConstructPath(sharedContext.name, 'response');
	try {
		const files = await fs.readdir(responsesPath);
		return files.filter((file) => file.endsWith('.ts') && file !== 'index.ts').map((file) => file.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

const hasResponseInterface = async (responseName: string): Promise<boolean> => {
	const { sharedContext } = await getSharedState();
	const responsePath = path.join(getFoundationConstructPath(sharedContext.name, 'response'), `${responseName}.ts`);
	try {
		const content = await fs.readFile(responsePath, 'utf-8');
		const interfaceRegex = new RegExp(`export\\s+interface\\s+I${responseName}\\b`);
		return interfaceRegex.test(content);
	} catch {
		return false;
	}
};

const resolveTargetPath = (target: string): string => {
	if (target === '__shared__') {
		throw new Error('Shared target path must be resolved async.');
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

	const selectedTarget = String(target ?? '__shared__');
	const sharedResponses = await getSharedResponses();

	let selectedResponse: string | null = null;
	if (sharedResponses.length > 0) {
		const { responseName } = await prompts({
			type: 'select',
			name: 'responseName',
			message: 'Select response for datasource:',
			choices: [{ title: 'No response', value: null }, ...sharedResponses.map((response) => ({ title: response, value: response }))],
			initial: 0
		});
		selectedResponse = responseName ? String(responseName) : null;
	}

	let content: string;
	if (!selectedResponse) {
		content = createDatasourceTemplateWithoutResponse(className);
	} else {
		const { sharedAlias } = await getSharedState();
		const responseImportPath = getFoundationConstructImportPath(sharedAlias, 'response');
		const withInterface = await hasResponseInterface(selectedResponse);
		content = withInterface
			? createDatasourceTemplateWithResponseAndInterface(className, selectedResponse, responseImportPath)
			: createDatasourceTemplateWithResponse(className, selectedResponse, responseImportPath);
	}

	const targetPath =
		selectedTarget === '__shared__'
			? getFoundationConstructPath((await getSharedState()).sharedContext.name, 'datasource')
			: resolveTargetPath(selectedTarget);
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
