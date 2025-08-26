import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const datasourceWithResponseTemplate = `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';
import { {{responseClass}} } from '{{responseImport}}';

export class {{name}}Datasource extends BaseHttpDatasource {
\tasync createRequest<T>(callback: CreateRequestCallbackType<T>) {
\t\treturn new {{responseClass}}<T>(await this.createRawRequest<T>(callback));
\t}
}`;

export default async function generateDatasource() {
    const context = await selectContext('Select context for datasource (or shared):');

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Datasource name (without "Datasource" suffix):'
    });

    const pascalName = toPascalCase(name);
    const contextPath = context === 'shared'
        ? path.join(process.cwd(), 'src/app/shared')
        : getContextPath(context);

    // Get available responses
    const sharedResponses = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/shared/Response')
    );

    const contextResponses = context !== 'shared'
        ? await getAvailableFiles(path.join(contextPath, 'Infrastructure/Response'))
        : [];

    const allResponses = [
        ...sharedResponses.map(r => ({
            title: `${r} (shared)`,
            value: { name: r, from: 'shared' }
        })),
        ...contextResponses.map(r => ({
            title: `${r} (${context})`,
            value: { name: r, from: context }
        }))
    ];

    if (allResponses.length === 0) {
        console.error('❌ No responses available. Create a response first with make:response');
        return;
    }

    const { response } = await prompts({
        type: 'select',
        name: 'response',
        message: 'Select response for datasource:',
        choices: allResponses
    });

    // Determine interface name
    const responseInterface = `I${response.name.replace('Response', '')}Response`;

    const datasourcePath = context === 'shared'
        ? path.join(contextPath, 'Datasource')
        : path.join(contextPath, 'Infrastructure/Http/Datasource');

    const responseImport = response.from === 'shared'
        ? context === 'shared' ? '../Response' : '$shared/Response'
        : `\$${context}/Infrastructure/Response`;

    const content = datasourceWithResponseTemplate
        .replace(/{{name}}/g, pascalName)
        .replace(/{{responseClass}}/g, response.name)
        .replace(/{{responseInterface}}/g, responseInterface)
        .replace(/{{responseImport}}/g, responseImport);

    const filePath = path.join(datasourcePath, `${pascalName}Datasource.ts`);
    await writeIfNotExists(filePath, content);
    await updateIndexTs(datasourcePath);

    console.log(`✅ Datasource created at ${filePath}`);
}