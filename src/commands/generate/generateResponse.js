import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const responseTemplate = `import { ResponseBuilder } from '@azure-net/kit/infra';

export interface I{{name}}Response<T = unknown> {
\tdata: T;
\tsuccess: boolean;
\tmessage: string;
}

export class {{name}}Response<TData = unknown, TMeta = unknown> extends ResponseBuilder<TData, TMeta, I{{name}}Response<TData>> {
\toverride unwrapData(data: I{{name}}Response<TData>): TData {
\t\treturn data.data;
\t}
}`;

export default async function generateResponse() {
    const context = await selectContext();

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Response name (without "Response" suffix):'
    });

    const pascalName = toPascalCase(name);
    const contextPath = getContextPath(context);
    const responsePath = context === 'core'
        ? path.join(contextPath, 'Response')
        : path.join(contextPath, 'Infrastructure/Response');

    const content = responseTemplate.replace(/{{name}}/g, pascalName);
    const filePath = path.join(responsePath, `${pascalName}Response.ts`);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(responsePath);

    console.log(`✅ Response created at ${filePath}`);
}