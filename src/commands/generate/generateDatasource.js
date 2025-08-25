import prompts from 'prompts';
import { selectContext, getContextPath, toPascalCase } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
import path from 'path';

const datasourceTemplate = `import { BaseHttpDatasource } from '@azure-net/kit/infra';
import { HttpService } from '@azure-net/kit/infra';

export class {{name}}Datasource extends BaseHttpDatasource {
\tconstructor() {
\t\tsuper({ 
\t\t\thttp: new HttpService({ 
\t\t\t\tbaseUrl: 'https://api.example.com'
\t\t\t}) 
\t\t});
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
    const datasourcePath = context === 'core'
        ? path.join(contextPath, 'Datasource')
        : path.join(contextPath, 'Infrastructure', 'Http', 'Datasource');

    const content = datasourceTemplate.replace(/{{name}}/g, pascalName);
    const filePath = path.join(datasourcePath, `${pascalName}Datasource.ts`);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(datasourcePath);

    console.log(`✅ Datasource created at ${filePath}`);
}