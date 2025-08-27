import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs, updateCoreIndex } from '../../utils/fileUtils.js';

const responseTemplate = `import { ResponseBuilder } from '@azure-net/kit/infra';

export class {{name}}Response<TData = unknown, TMeta = unknown> extends ResponseBuilder<TData, TMeta, TData> {
}`;

export default async function generateResponse() {
    const context = await selectContext('Select context for response (or core):');

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Response name (without "Response" suffix):'
    });

    const pascalName = toPascalCase(name);
    const contextPath = context === 'core'
        ? path.join(process.cwd(), 'src/app/core')
        : getContextPath(context);

    const responsePath = context === 'core'
        ? path.join(contextPath, 'responses')
        : path.join(contextPath, 'infrastructure/responses');

    const content = responseTemplate.replace(/{{name}}/g, pascalName);
    const filePath = path.join(responsePath, `${pascalName}Response.ts`);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(responsePath);

    // Update core index if needed
    if (context === 'core') {
        await updateCoreIndex();
    }

    console.log(`✅ Response created at ${filePath}`);
}