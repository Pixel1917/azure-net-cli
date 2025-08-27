import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs, updateCoreIndex } from '../../utils/fileUtils.js';

const datasourceWithResponseTemplate = `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';
import { {{responseClass}} } from '{{responseImport}}';

export class {{name}}Datasource extends BaseHttpDatasource {
\tasync createRequest<T>(callback: CreateRequestCallbackType<T>) {
\t\treturn new {{responseClass}}<T>(await this.createRawRequest<T>(callback));
\t}
}`;

export default async function generateDatasource() {
    const context = await selectContext('Select context for datasource (or core):');

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Datasource name (without "Datasource" suffix):'
    });

    const pascalName = toPascalCase(name);
    const contextPath = context === 'core'
        ? path.join(process.cwd(), 'src/app/core')
        : getContextPath(context);

    // Get available responses
    const coreResponses = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/responses')
    );

    const contextResponses = context !== 'core'
        ? await getAvailableFiles(path.join(contextPath, 'infrastructure/responses'))
        : [];

    const allResponses = [
        ...coreResponses.map(r => ({
            title: `${r} (core)`,
            value: { name: r, from: 'core' }
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

    const datasourcePath = context === 'core'
        ? path.join(contextPath, 'datasources')
        : path.join(contextPath, 'infrastructure/http/datasources');

    const responseImport = response.from === 'core'
        ? context === 'core' ? '../responses' : '$core/responses'
        : `\$${context}/infrastructure/responses`;

    const content = datasourceWithResponseTemplate
        .replace(/{{name}}/g, pascalName)
        .replace(/{{responseClass}}/g, response.name)
        .replace(/{{responseImport}}/g, responseImport);

    const filePath = path.join(datasourcePath, `${pascalName}Datasource.ts`);
    await writeIfNotExists(filePath, content);
    await updateIndexTs(datasourcePath);

    // Update core index if needed
    if (context === 'core') {
        await updateCoreIndex();
    }

    console.log(`✅ Datasource created at ${filePath}`);
}