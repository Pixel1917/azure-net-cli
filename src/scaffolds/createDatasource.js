import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { normalizePascalName, getPlatformPath } from '../utils/architecture.js';
import { registerDatasource } from './registerDatasource.js';
export default async function createDatasource() {
    const { datasourceNameRaw } = await prompts({
        type: 'text',
        name: 'datasourceNameRaw',
        message: 'Datasource name:',
        initial: 'ApiDatasource'
    });
    if (datasourceNameRaw === undefined)
        return;
    const normalized = normalizePascalName(String(datasourceNameRaw));
    const className = normalized.endsWith('Datasource') ? normalized : `${normalized}Datasource`;
    const responseRoot = path.join(getPlatformPath(), 'Foundation/Response');
    let responses = [];
    try {
        responses = (await fs.readdir(responseRoot))
            .filter((file) => file.endsWith('Response.ts') && !file.endsWith('.d.ts'))
            .map((file) => file.slice(0, -3));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    let response;
    if (responses.length) {
        const answer = await prompts({
            type: 'select',
            name: 'responseName',
            message: 'Select response for datasource:',
            choices: [{ title: 'No response', value: '' }, ...responses.map((name) => ({ title: name, value: name }))]
        });
        response = answer.responseName || undefined;
        if (response && !responses.includes(response))
            throw new Error('Unknown response selected.');
    }
    let rawType = 'TData';
    let resultType = 'IHttpServiceResponse<TData>';
    let imports = '';
    let generic = 'TData';
    let localResultInterface = '';
    if (response) {
        const content = await fs.readFile(path.join(responseRoot, `${response}.ts`), 'utf8');
        const declaration = content.match(new RegExp(`export\\s+(?:interface|type)\\s+I${response}\\s*<([^>]+)>`));
        if (declaration)
            rawType = `I${response}<${declaration[1].includes(',') ? 'TData, TMeta' : 'TData'}>`;
        generic = 'TData, TMeta = unknown';
        resultType = `I${response}Result<TData, TMeta>`;
        const hasResult = new RegExp(`export\\s+interface\\s+I${response}Result\\b`).test(content);
        if (!hasResult)
            localResultInterface = `interface I${response}Result<TData = unknown, TMeta = unknown> extends Pick<${response}<TData, TMeta>, keyof ${response}<TData, TMeta>> {}\n`;
        imports = `import { ${response}${declaration ? `, type I${response}` : ''}${hasResult ? `, type I${response}Result` : ''} } from '#platform/Foundation/Response/${response}';\n`;
    }
    const root = path.join(getPlatformPath(), 'Foundation/Datasource');
    const created = await writeIfNotExists(path.join(root, `${className}.ts`), `import { BaseHttpDatasource, type CreateRequestCallbackType${response ? '' : ', type IHttpServiceResponse'} } from '@azure-net/kit/infra';
${imports}${localResultInterface}
export interface I${className} extends Pick<BaseHttpDatasource, keyof BaseHttpDatasource> {
	createRequest<${generic}>(callback: CreateRequestCallbackType<${rawType}>): Promise<${resultType}>;
}

export class ${className} extends BaseHttpDatasource implements I${className} {
	async createRequest<${generic}>(callback: CreateRequestCallbackType<${rawType}>): Promise<${resultType}> {
		return ${response ? `new ${response}<TData, TMeta>(await this.createRawRequest<${rawType}>(callback))` : 'await this.createRawRequest<TData>(callback)'};
	}
}
`);
    await updateIndexTs(root);
    if (!created)
        return;
    const { provider } = await prompts({
        type: 'confirm',
        name: 'provider',
        message: 'Create HttpProvider for this datasource?',
        initial: true
    });
    if (provider)
        await registerDatasource(className);
}
