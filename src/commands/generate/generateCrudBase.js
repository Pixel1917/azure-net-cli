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

// Templates for CRUD base generation
const entityTemplate = `export interface I{{name}} {
\tid: number;
\t// Add entity fields here
\tcreated_at: string;
\tupdated_at: string;
}`;

const portsIndexTemplate = `import type { I{{name}} } from '\${{context}}/domain/{{entityLower}}/model';

export interface I{{name}}Collection {
\tdata: I{{name}}[];
\ttotal: number;
}

export interface I{{name}}CollectionQuery {
\tpage?: number;
\tperPage?: number;
\t[key: string]: unknown;
}

export interface I{{name}}CreateRequest {
\t// Add request fields here
\t[key: string]: unknown;
}

export interface I{{name}}UpdateRequest {
\t// Add request fields here
\t[key: string]: unknown;
}`;

const repositoryTemplate = `import { {{datasource}} } from '{{datasourceImport}}';
import type { 
\tI{{name}},
\tI{{name}}Collection,
\tI{{name}}CollectionQuery,
\tI{{name}}CreateRequest,
\tI{{name}}UpdateRequest
} from '\${{context}}/domain/{{entityLower}}';

export class {{name}}Repository {
\tprivate endpoint = '{{endpoint}}';
\t
\tconstructor(private {{datasourceVar}}: {{datasource}}) {}
\t
\tpublic async collection(query?: I{{name}}CollectionQuery) {
\t\treturn this.{{datasourceVar}}.createRequest<I{{name}}Collection>(({ http, query: q }) => 
\t\t\thttp.get(\`\${this.endpoint}\${q.build(query || {})}\`)
\t\t).then(res => res.getData());
\t}
\t
\tpublic async resource(id: number) {
\t\treturn this.{{datasourceVar}}.createRequest<I{{name}}>(({ http }) => 
\t\t\thttp.get(\`\${this.endpoint}/\${id}\`)
\t\t).then(res => res.getData());
\t}
\t
\tpublic async create(data: I{{name}}CreateRequest) {
\t\treturn this.{{datasourceVar}}.createRequest<I{{name}}>(({ http }) => 
\t\t\thttp.post(this.endpoint, { json: data })
\t\t).then(res => res.getData());
\t}
\t
\tpublic async update(id: number, data: I{{name}}UpdateRequest) {
\t\treturn this.{{datasourceVar}}.createRequest<I{{name}}>(({ http }) => 
\t\t\thttp.put(\`\${this.endpoint}/\${id}\`, { json: data })
\t\t).then(res => res.getData());
\t}
\t
\tpublic async remove(id: number) {
\t\treturn this.{{datasourceVar}}.createRequest<void>(({ http }) => 
\t\t\thttp.delete(\`\${this.endpoint}/\${id}\`)
\t\t).then(() => undefined);
\t}
}`;

const serviceTemplate = `import { ClassMirror } from '@azure-net/kit';
import { {{name}}Repository } from '\${{context}}/infrastructure/http/repositories';

export class {{name}}Service extends ClassMirror<{{name}}Repository> {
\tconstructor(private {{camelName}}Repository: {{name}}Repository) {
\t\tsuper({{camelName}}Repository);
\t}
\t
\tdeclare collection: {{name}}Repository['collection'];
\tdeclare resource: {{name}}Repository['resource'];
\tdeclare create: {{name}}Repository['create'];
\tdeclare update: {{name}}Repository['update'];
\tdeclare remove: {{name}}Repository['remove'];
}`;

export default async function generateCrudBase() {
    const context = await selectContext('Select context for CRUD base:');

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Entity name (PascalCase):'
    });

    const { endpoint } = await prompts({
        type: 'text',
        name: 'endpoint',
        message: 'API endpoint (e.g. /api/users):'
    });

    // Get available datasources
    const contextPath = getContextPath(context);
    const coreDatasources = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/datasources')
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

    console.log('\n🚀 Generating CRUD base (repository & service)...\n');

    // 1. Create Domain structure
    const domainPath = path.join(contextPath, 'domain', entityLower);
    const modelPath = path.join(domainPath, 'model');
    const portsPath = path.join(domainPath, 'ports');

    // Create Model
    await writeIfNotExists(
        path.join(modelPath, 'index.ts'),
        entityTemplate.replace(/{{name}}/g, pascalName)
    );

    // Create Ports
    await writeIfNotExists(
        path.join(portsPath, 'index.ts'),
        portsIndexTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{entityLower}}/g, entityLower)
    );

    // Create Domain module index
    await writeIfNotExists(
        path.join(domainPath, 'index.ts'),
        `export * from './model';\nexport * from './ports';`
    );

    // 2. Create Repository
    const repoPath = path.join(contextPath, 'infrastructure/http/repositories');
    const datasourceImport = datasource.from === 'core'
        ? '$core/datasources'
        : `\$${context}/infrastructure/http/datasources`;

    await writeIfNotExists(
        path.join(repoPath, `${pascalName}Repository.ts`),
        repositoryTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{endpoint}}/g, endpoint)
            .replace(/{{datasource}}/g, datasource.name)
            .replace(/{{datasourceImport}}/g, datasourceImport)
            .replace(/{{datasourceVar}}/g, toCamelCase(datasource.name))
            .replace(/{{entityLower}}/g, entityLower)
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

    console.log(`✅ CRUD base for ${pascalName} created successfully!`);
    console.log(`\n💡 Remember to:`);
    console.log(`   1. Add ${pascalName}Repository to InfrastructureProvider`);
    console.log(`   2. Add ${pascalName}Service to ApplicationProvider`);
    console.log(`   3. Use 'make:crud-presenter' to create the CRUD presenter`);
}