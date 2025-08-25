import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, toCamelCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs, ensureIndexExports } from '../../utils/fileUtils.js';
import { ensureProvider, addToProvider } from '../../utils/providerUtils.js';

// Templates for CRUD generation
const entityTemplate = `export interface I{{name}} {
\tid: number;
\t// Add entity fields here
\tcreated_at: string;
\tupdated_at: string;
}`;

const portsIndexTemplate = `export interface I{{name}}Collection {
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
}

export interface I{{name}}UpdateRequest {
\t// Add request fields here  
}`;

const repositoryTemplate = `import { {{datasource}} } from '{{datasourceImport}}';
import type { I{{name}} } from '${{context}}/Domain/Entities/{{name}}';
import type { 
\tI{{name}}Collection,
\tI{{name}}CollectionQuery,
\tI{{name}}CreateRequest,
\tI{{name}}UpdateRequest
} from '${{context}}/Domain/Ports/{{name}}';

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
import { {{name}}Repository } from '../../Infrastructure/Http/Repositories';

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

const createSchemaTemplate = `import { {{schemaFactory}} } from '{{schemaImport}}';
import type { I{{name}}CreateRequest } from '${{context}}/Domain/Ports/{{name}}';

export const Create{{name}}Schema = {{schemaFactory}}<I{{name}}CreateRequest>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const updateSchemaTemplate = `import { {{schemaFactory}} } from '{{schemaImport}}';
import type { I{{name}}UpdateRequest } from '${{context}}/Domain/Ports/{{name}}';

export const Update{{name}}Schema = {{schemaFactory}}<I{{name}}UpdateRequest>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const presenterTemplate = `import { {{presenterFactory}} } from '{{presenterImport}}';
import { ApplicationProvider } from '${{context}}/Application';
import { Create{{name}}Schema, Update{{name}}Schema } from './Schema';
import type { 
\tI{{name}}CollectionQuery,
\tI{{name}}CreateRequest,
\tI{{name}}UpdateRequest
} from '${{context}}/Domain/Ports/{{name}}';

export const {{name}}Presenter = {{presenterFactory}}('{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\tconst { {{name}}Service } = ApplicationProvider();
\t
\tconst collection = async (query?: I{{name}}CollectionQuery) => 
\t\tawait createAsyncResource({{name}}Service.collection(query));
\t
\tconst resource = async (id: number) => 
\t\tawait createAsyncResource({{name}}Service.resource(id));
\t
\tconst create = async (request: I{{name}}CreateRequest) =>
\t\tawait createAsyncAction({{name}}Service.create(Create{{name}}Schema.from(request).json()));
\t
\tconst update = async (id: number, request: I{{name}}UpdateRequest) =>
\t\tawait createAsyncAction({{name}}Service.update(id, Update{{name}}Schema.from(request).json()));
\t
\tconst remove = async (id: number) => 
\t\tawait createAsyncAction({{name}}Service.remove(id));
\t
\treturn { collection, resource, create, update, remove };
});`;

export default async function generateCrud() {
    const context = await selectContext('Select context for CRUD module:');

    if (context === 'core') {
        console.error('❌ Cannot create CRUD in core. Choose a specific context.');
        return;
    }

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
        path.join(process.cwd(), 'src/app/core/Datasource')
    );
    const contextDatasources = await getAvailableFiles(
        path.join(contextPath, 'Infrastructure/Http/Datasource')
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

    // Get schema and presenter factories
    const coreSchemas = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Schema')
    );

    const { schemaType } = await prompts({
        type: 'select',
        name: 'schemaType',
        message: 'Select schema factory:',
        choices: [
            { title: 'Use createSchemaFactory from package', value: 'package' },
            ...coreSchemas.map(s => ({ title: `Use ${s} from core`, value: s }))
        ]
    });

    const corePresenters = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Presenter')
    );

    const { presenterType } = await prompts({
        type: 'select',
        name: 'presenterType',
        message: 'Select presenter factory:',
        choices: [
            { title: 'Use createPresenter from package', value: 'package' },
            ...corePresenters.map(p => ({ title: `Use ${p} from core`, value: p }))
        ]
    });

    const pascalName = toPascalCase(name);
    const camelName = toCamelCase(name);
    const contextName = toPascalCase(context);

    console.log('\n🚀 Generating CRUD module...\n');

    // 1. Create Entity
    const entityPath = path.join(contextPath, 'Domain', 'Entities', pascalName);
    await writeIfNotExists(
        path.join(entityPath, 'index.ts'),
        entityTemplate.replace(/{{name}}/g, pascalName)
    );

    // 2. Create Ports
    const portsPath = path.join(contextPath, 'Domain', 'Ports', pascalName);
    await writeIfNotExists(
        path.join(portsPath, 'index.ts'),
        portsIndexTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
    );

    // 3. Create Repository
    const repoPath = path.join(contextPath, 'Infrastructure', 'Http', 'Repositories');
    const datasourceImport = datasource.from === 'core'
        ? '$core/Datasource'
        : `$${context}/Infrastructure/Http/Datasource`;

    await writeIfNotExists(
        path.join(repoPath, `${pascalName}Repository.ts`),
        repositoryTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{endpoint}}/g, endpoint)
            .replace(/{{datasource}}/g, datasource.name)
            .replace(/{{datasourceImport}}/g, datasourceImport)
            .replace(/{{datasourceVar}}/g, toCamelCase(datasource.name))
    );
    await updateIndexTs(repoPath);

    // 4. Create Service
    const servicePath = path.join(contextPath, 'Application', 'Services');
    await writeIfNotExists(
        path.join(servicePath, `${pascalName}Service.ts`),
        serviceTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{camelName}}/g, camelName)
    );
    await updateIndexTs(servicePath);

    // 5. Create Delivery module structure
    const deliveryModulePath = path.join(contextPath, 'Delivery', pascalName);
    const schemaPath = path.join(deliveryModulePath, 'Schema');

    // Create schemas
    const schemaFactory = schemaType === 'package' ? 'createSchemaFactory' : schemaType;
    const schemaImport = schemaType === 'package'
        ? '@azure-net/kit'
        : '$core/Schema';

    await writeIfNotExists(
        path.join(schemaPath, `Create${pascalName}Schema.ts`),
        createSchemaTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{schemaFactory}}/g, schemaFactory)
            .replace(/{{schemaImport}}/g, schemaImport)
    );

    await writeIfNotExists(
        path.join(schemaPath, `Update${pascalName}Schema.ts`),
        updateSchemaTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{schemaFactory}}/g, schemaFactory)
            .replace(/{{schemaImport}}/g, schemaImport)
    );
    await updateIndexTs(schemaPath);

    // 6. Create Presenter
    const presenterFactory = presenterType === 'package' ? 'createPresenter' : presenterType;
    const presenterImport = presenterType === 'package'
        ? '@azure-net/kit'
        : '$core/Presenter';

    await writeIfNotExists(
        path.join(deliveryModulePath, `${pascalName}Presenter.ts`),
        presenterTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{presenterFactory}}/g, presenterFactory)
            .replace(/{{presenterImport}}/g, presenterImport)
    );

    // Create module index
    await writeIfNotExists(
        path.join(deliveryModulePath, 'index.ts'),
        `export * from './${pascalName}Presenter';\nexport * from './Schema';`
    );

    // 7. Setup Providers
    // Ensure DatasourceProvider
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

    // Ensure InfrastructureProvider
    const infraProvider = await ensureProvider(context, 'Infrastructure', {});
    await addToProvider(
        infraProvider.path,
        `${pascalName}Repository`,
        '../Http/Repositories',
        `DatasourceProvider.${datasource.name}`
    );

    // Ensure ApplicationProvider
    const appProvider = await ensureProvider(context, 'Application', { infrastructure: true });
    await addToProvider(
        appProvider.path,
        `${pascalName}Service`,
        '../Services',
        `InfrastructureProvider.${pascalName}Repository`
    );

    // Update all layer indexes
    await ensureIndexExports(path.join(contextPath, 'Infrastructure'));
    await ensureIndexExports(path.join(contextPath, 'Application'));

    console.log(`✅ CRUD module for ${pascalName} created successfully!`);
}