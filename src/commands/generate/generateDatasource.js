import prompts from 'prompts';
import { selectContext, getContextPath, toPascalCase } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
import path from 'path';

const datasourceTemplate = `import { BaseHttpDatasource, HttpService } from '@azure-net/kit';

export class {{name}}Datasource extends BaseHttpDatasource {
\tconstructor() {
\t\tsuper({ http: new HttpService({ baseUrl: '' }) });
\t}
}`;

export default async function generateDatasource() {
    const context = await selectContext();

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Datasource name (PascalCase):'
    });

    const pascalName = toPascalCase(name);
    const contextPath = getContextPath(context);
    const datasourcePath = context === 'core'
        ? path.join(contextPath, 'Datasources')
        : path.join(contextPath, 'Infrastructure', 'Datasources');

    const content = datasourceTemplate.replace(/{{name}}/g, pascalName);
    const filePath = path.join(datasourcePath, `${pascalName}Datasource.ts`);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(datasourcePath);

    console.log(`✅ Datasource created at ${filePath}`);
}