import prompts from 'prompts';
import path from 'path';
import {
    selectContext,
    getContextPath,
    toPascalCase,
    toCamelCase,
    getAvailableFiles,
    toKebabCase
} from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs, updateCoreIndex } from '../../utils/fileUtils.js';

const entityTemplate = `export interface I{{name}} {
\tid: number;
\t// Add entity fields here
\tcreated_at: string;
\tupdated_at: string;
}`;

const repositoryTemplate = `import { {{datasource}} } from '{{datasourceImport}}';

export class {{name}}Repository {
\tprivate endpoint = '{{endpoint}}';
\t
\tconstructor(private {{datasourceVar}}: {{datasource}}) {}
\t
\tpublic async example() {
\t\treturn this.{{datasourceVar}}.createRequest(({ http }) =>
\t\t\thttp.get(this.endpoint)
\t\t).then(res => res.getData());
\t}
}`;

const serviceTemplate = `import { ClassMirror } from '@azure-net/kit';
import { {{name}}Repository } from '\${{context}}/infrastructure/http/repositories';

export class {{name}}Service extends ClassMirror<{{name}}Repository> {
\tconstructor(private {{camelName}}Repository: {{name}}Repository) {
\t\tsuper({{camelName}}Repository);
\t}
\t
\tdeclare example: {{name}}Repository['example'];
}`;

export default async function generateModuleBase() {
    const context = await selectContext('Select context for module base:');

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Module name (PascalCase):'
    });

    const { endpoint } = await prompts({
        type: 'text',
        name: 'endpoint',
        message: 'API endpoint (e.g. /api/users):'
    });

    const { needEntity } = await prompts({
        type: 'confirm',
        name: 'needEntity',
        message: 'Create domain entity?',
        initial: true
    });

    // Get available datasources
    const contextPath = getContextPath(context);
    const coreDatasources = await getAvailableFiles(
        path.join(process.cwd(), 'src/core/datasources')
    );
    const contextDatasources = await getAvailableFiles(
        path.join(contextPath, 'infrastructure/http/datasources')
    );

    const allDatasources = [
        ...coreDatasources.map(d => ({ title: `${d} (core)`, value: { name: d, from: 'core' } })),
        ...contextDatasources.map(d => ({ title: `${d} (${context})`, value: { name: d, from: context } }))
    ];

    const { datasource } = await prompts({
        type: 'select',
        name: 'datasource',
        message: 'Select datasource:',
        choices: allDatasources
    });

    const pascalName = toPascalCase(name);
    const camelName = toCamelCase(name);
    const entityLower = toKebabCase(pascalName);

    console.log('\n🚀 Generating module base (repository & service)...\n');

    // 1. Create Domain entity if needed
    if (needEntity) {
        const domainPath = path.join(contextPath, 'domain', entityLower);
        const modelPath = path.join(domainPath, 'model');

        await writeIfNotExists(
            path.join(modelPath, `I${pascalName}.ts`),
            entityTemplate.replace(/{{name}}/g, pascalName)
        );

        await writeIfNotExists(
            path.join(modelPath, 'index.ts'),
            `export * from './I${pascalName}';`
        );

        await writeIfNotExists(
            path.join(domainPath, 'index.ts'),
            `export * from './model';`
        );

        console.log(`✅ Domain entity I${pascalName} created`);
    }

    // 2. Create Repository
    const repoPath = path.join(contextPath, 'infrastructure/http/repositories');
    const datasourceImport = datasource.from === 'core'
        ? '$core/datasources'
        : `\$${context}/infrastructure/http/datasources`;

    await writeIfNotExists(
        path.join(repoPath, `${pascalName}Repository.ts`),
        repositoryTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{endpoint}}/g, endpoint)
            .replace(/{{datasource}}/g, datasource.name)
            .replace(/{{datasourceImport}}/g, datasourceImport)
            .replace(/{{datasourceVar}}/g, toCamelCase(datasource.name))
    );
    await updateIndexTs(repoPath);

    // 3. Create Service
    const servicePath = path.join(contextPath, 'application/services');
    await writeIfNotExists(
        path.join(servicePath, `${pascalName}Service.ts`),
        serviceTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{camelName}}/g, camelName)
            .replace(/{{context}}/g, context)
    );
    await updateIndexTs(servicePath);

    // Update core index
    await updateCoreIndex();

    console.log(`\n✅ Module base for ${pascalName} created successfully!`);
    console.log(`\n💡 Remember to:`);
    console.log(`   1. Add ${pascalName}Repository to InfrastructureProvider`);
    console.log(`   2. Add ${pascalName}Service to ApplicationProvider`);
}
