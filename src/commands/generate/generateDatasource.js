import prompts from 'prompts';
import path from 'path';
import fs from 'fs/promises';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const datasourceWithResponseTemplate = `import { BaseHttpDatasource, type CreateRequestCallbackType } from '@azure-net/kit/infra';
import { {{responseClass}}, type {{responseInterface}} } from '{{responseImport}}';
import { HttpService } from '@azure-net/kit/infra';

export class {{name}}Datasource extends BaseHttpDatasource {
\tasync createRequest<T>(callback: CreateRequestCallbackType<{{responseInterface}}<T>>) {
\t\treturn new {{responseClass}}<T>(await this.createRawRequest<{{responseInterface}}<T>>(callback));
\t}
}`;

export default async function generateDatasource() {
    const context = await selectContext();

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Datasource name (without "Datasource" suffix):'
    });

    const pascalName = toPascalCase(name);
    const contextPath = getContextPath(context);

    // Get available responses
    const coreResponses = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Response')
    );

    const contextResponses = context !== 'core'
        ? await getAvailableFiles(path.join(contextPath, 'Infrastructure/Response'))
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

    // Determine interface name
    const responseInterface = `I${response.name.replace('Response', '')}Response`;

    const datasourcePath = context === 'core'
        ? path.join(contextPath, 'Datasource')
        : path.join(contextPath, 'Infrastructure/Http/Datasource');

    const responseImport = response.from === 'core'
        ? context === 'core' ? '../Response' : '$core/Response'
        : context === 'core'
            ? `../contexts/${context}/Infrastructure/Response`
            : '../../Response';

    const content = datasourceWithResponseTemplate
        .replace(/{{name}}/g, pascalName)
        .replace(/{{responseClass}}/g, response.name)
        .replace(/{{responseInterface}}/g, responseInterface)
        .replace(/{{responseImport}}/g, responseImport);

    const filePath = path.join(datasourcePath, `${pascalName}Datasource.ts`);
    await writeIfNotExists(filePath, content);
    await updateIndexTs(datasourcePath);

    console.log(`✅ Datasource created at ${filePath}`);
    console.log(`\n💡 Remember to configure the datasource in DatasourceProvider when using it in repositories.`);
}