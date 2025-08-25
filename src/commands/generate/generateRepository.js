import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
import { ensureProvider, addToProvider } from '../../utils/providerUtils.js';

const repositoryTemplate = `import { {{datasource}} } from '{{datasourceImport}}';

export class {{name}}Repository {
\tconstructor(private {{datasourceVar}}: {{datasource}}) {}
\t
\tpublic async example() {
\t\treturn this.{{datasourceVar}}.createRequest(({ http }) => 
\t\t\thttp.get('/endpoint')
\t\t).then(res => res.getData());
\t}
}`;

export default async function generateRepository() {
    const context = await selectContext('Select context for repository:');

    if (context === 'core') {
        console.error('❌ Cannot create repository in core. Choose a specific context.');
        return;
    }

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Repository name (without "Repository" suffix):'
    });

    // Get available datasources
    const contextPath = getContextPath(context);
    const coreDatasources = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Datasources')
    );
    const contextDatasources = await getAvailableFiles(
        path.join(contextPath, 'Infrastructure', 'Datasources')
    );

    const allDatasources = [
        ...coreDatasources.map(d => ({ title: `${d}Datasource (core)`, value: { name: `${d}Datasource`, from: 'core' } })),
        ...contextDatasources.map(d => ({ title: `${d}Datasource (${context})`, value: { name: `${d}Datasource`, from: context } }))
    ];

    if (allDatasources.length === 0) {
        console.error('❌ No datasources available. Create a datasource first.');
        return;
    }

    const { datasource } = await prompts({
        type: 'select',
        name: 'datasource',
        message: 'Select datasource:',
        choices: allDatasources
    });

    const pascalName = toPascalCase(name);
    const repoPath = path.join(contextPath, 'Infrastructure', 'Repositories');
    const filePath = path.join(repoPath, `${pascalName}Repository.ts`);

    // Generate repository
    const datasourceImport = datasource.from === 'core'
        ? '$core/Datasources/index.js'
        : '../Datasources/index.js';

    const content = repositoryTemplate
        .replace(/{{name}}/g, pascalName)
        .replace(/{{datasource}}/g, datasource.name)
        .replace(/{{datasourceImport}}/g, datasourceImport)
        .replace(/{{datasourceVar}}/g, toPascalCase(datasource.name).charAt(0).toLowerCase() + toPascalCase(datasource.name).slice(1));

    await writeIfNotExists(filePath, content);
    await updateIndexTs(repoPath);

    // Ensure DatasourceProvider exists
    const datasourceProvider = await ensureProvider(context, 'Infrastructure', { datasource: datasource.name });

    // Ensure InfrastructureProvider exists and add repository
    const infraProvider = await ensureProvider(context, 'Infrastructure', { datasource: datasource.name });
    await addToProvider(
        infraProvider.path,
        `${pascalName}Repository`,
        '../Repositories/index.js'
    );

    // Add datasource dependency to repository in provider
    let providerContent = await fs.readFile(infraProvider.path, 'utf-8');
    const repoFactory = `${pascalName}Repository: () => new ${pascalName}Repository()`;
    const repoWithDatasource = `${pascalName}Repository: () => new ${pascalName}Repository(DatasourceProvider.${datasource.name})`;
    providerContent = providerContent.replace(repoFactory, repoWithDatasource);
    await fs.writeFile(infraProvider.path, providerContent, 'utf-8');

    console.log(`✅ Repository created at ${filePath}`);
}