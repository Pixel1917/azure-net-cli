import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';

const createResponseWithWrapperTemplate = (name) => {
	const interfaceName = `I${name}`;
	return `import { ResponseBuilder } from '@azure-net/kit/infra';

export interface ${interfaceName}<T> {
\tdata: T;
}

export class ${name}<TData = unknown, TMeta = unknown> extends ResponseBuilder<TData, TMeta, ${interfaceName}<TData>> {
\tprotected unwrapData(data: ${interfaceName}<TData>): TData {
\t\treturn data.data;
\t}
}
`;
};

const createResponseSimpleTemplate = (name) => `import { ResponseBuilder } from '@azure-net/kit/infra';

export class ${name}<TData = unknown, TMeta = unknown> extends ResponseBuilder<TData, TMeta> {}
`;

const ensureResponseName = (rawName) => {
	const normalized = toPascalCase(rawName || 'ApiResponse') || 'ApiResponse';
	return normalized.endsWith('Response') ? normalized : `${normalized}Response`;
};

export default async function createResponse() {
	const { responseNameRaw } = await prompts({
		type: 'text',
		name: 'responseNameRaw',
		message: 'Response class name:',
		initial: 'ApiResponse'
	});

	const responseName = ensureResponseName(String(responseNameRaw ?? 'ApiResponse'));

	const { useCommonResponseWrapper } = await prompts({
		type: 'confirm',
		name: 'useCommonResponseWrapper',
		message: 'Use common backend response wrapper interface?',
		initial: true
	});

	const responseRoot = path.join(process.cwd(), 'src', 'core', 'response');
	const filePath = path.join(responseRoot, `${responseName}.ts`);
	await fs.mkdir(responseRoot, { recursive: true });

	const template = useCommonResponseWrapper ? createResponseWithWrapperTemplate(responseName) : createResponseSimpleTemplate(responseName);
	const created = await writeIfNotExists(filePath, template);
	await updateIndexTs(responseRoot);

	if (!created) {
		console.log(`⚠️ Response "${responseName}" already exists. File was not overwritten.`);
		return;
	}

	console.log(`✅ Response created: ${filePath}`);
}
