import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles, toCamelCase } from '../../utils/contextUtils.js';
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
        path.join(process.cwd(), 'src/app/core/Datasource')
    );
    const contextDatasources = await getAvailableFiles(
        path.join(contextPath, 'Infrastructure', 'Http', 'Datasource')
    );

    const allDatasources = [
        ...coreDatasources.map(d => ({ title: `${d} (core)`, value: { name: d, from: 'core' } })),
        ...contextDatasources.map(d => ({ title: `${d} (${context})`, value: { name: d, from: context } }))
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
    const contextName = toPascalCase(context);
    const repoPath = path.join(contextPath, 'Infrastructure', 'Http', 'Repositories');
    const filePath = path.join(repoPath, `${pascalName}Repository.ts`);

    // Generate repository
    const datasourceImport = datasource.from === 'core'
        ? '$core/Datasource'
        : '../Datasource';

    const content = repositoryTemplate
        .replace(/{{name}}/g, pascalName)
        .replace(/{{datasource}}/g, datasource.name)
        .replace(/{{datasourceImport}}/g, datasourceImport)
        .replace(/{{datasourceVar}}/g, toCamelCase(datasource.name));

    await writeIfNotExists(filePath, content);
    await updateIndexTs(repoPath);

    // Ensure DatasourceProvider exists
    const datasourceProviderPath = path.join(contextPath, 'Infrastructure', 'Providers', 'DatasourceProvider.ts');
    if (!(await fs.access(datasourceProviderPath).then(() => true).catch(() => false))) {
        const datasourceProviderContent = `import { createBoundaryProvider } from '@azure-net/kit';
import { ${datasource.name} } from '${datasource.from === 'core' ? '$core/Datasource' : '../Http/Datasource'}';

export const DatasourceProvider = createBoundaryProvider('${contextName}DatasourceProvider', () => ({
\t${datasource.name}: () => new ${datasource.name}()
}));`;
        await writeIfNotExists(datasourceProviderPath, datasourceProviderContent);
        await updateIndexTs(path.dirname(datasourceProviderPath));
    }

    // Ensure InfrastructureProvider and add repository
    const infraProvider = await ensureProvider(context, 'Infrastructure', { hasDatasource: true });
    await addToProvider(
        infraProvider.path,
        `${pascalName}Repository`,
        '../Http/Repositories',
        `DatasourceProvider.${datasource.name}`
    );

    console.log(`✅ Repository created at ${filePath}`);
}