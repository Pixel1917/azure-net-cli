import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const responseTemplate = `import { ResponseBuilder } from '@azure-net/kit/infra';

export class {{name}}Response<TData = unknown, TMeta = unknown> extends ResponseBuilder<TData, TMeta, I{{name}}Response<TData>> {
}`;

export default async function generateResponse() {
    const context = await selectContext('Select context for response (or shared):');

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Response name (without "Response" suffix):'
    });

    const pascalName = toPascalCase(name);
    const contextPath = context === 'shared'
        ? path.join(process.cwd(), 'src/app/shared')
        : getContextPath(context);

    const responsePath = context === 'shared'
        ? path.join(contextPath, 'Response')
        : path.join(contextPath, 'Infrastructure/Response');

    const content = responseTemplate.replace(/{{name}}/g, pascalName);
    const filePath = path.join(responsePath, `${pascalName}Response.ts`);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(responsePath);

    console.log(`✅ Response created at ${filePath}`);
}