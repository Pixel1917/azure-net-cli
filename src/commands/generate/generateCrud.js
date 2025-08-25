import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, toCamelCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
import { ensureProvider, addToProvider } from '../../utils/providerUtils.js';

// Templates for CRUD generation
const entityTemplate = `export interface I{{name}} {
\tid: number;
\t// Add entity fields here
\t[key: string]: unknown;
}

export type I{{name}}Collection = I{{name}}[];`;

const requestTemplate = `import type { I{{name}} } from '../../Entities/{{name}}/index.js';

export type I{{name}}CreateRequest = Omit<I{{name}}, 'id'>;
export type I{{name}}UpdateRequest = Partial<I{{name}}CreateRequest>;
export interface I{{name}}CollectionQuery {
\t[key: string]: unknown;
}`;

const repositoryTemplate = `import { {{datasource}} } from '{{datasourceImport}}';
import type {
\tI{{name}}Collection,
\tI{{name}},
\tI{{name}}CreateRequest,
\tI{{name}}UpdateRequest,
\tI{{name}}CollectionQuery
} from '../../Domain/Entities/{{name}}/index.js';
import type { I{{name}}CreateRequest as CreateRequest, I{{name}}UpdateRequest as UpdateRequest } from '../../Domain/Ports/{{name}}/index.js';

export class {{name}}Repository {
\tprivate endpoint = '{{endpoint}}';
\t
\tconstructor(private {{datasourceVar}}: {{datasource}}) {}
\t
\tpublic async collection(queryParams?: I{{name}}CollectionQuery) {
\t\treturn await this.{{datasourceVar}}.createRequest<I{{name}}Collection>(({ http, query }) => 
\t\t\thttp.get(\`\${this.endpoint}\${query.build(queryParams)}\`)
\t\t);
\t}
\t
\tpublic async resource(id: number) {
\t\treturn await this.{{datasourceVar}}.createRequest<I{{name}}>(({ http }) => 
\t\t\thttp.get(\`\${this.endpoint}/\${id}\`)
\t\t);
\t}
\t
\tpublic async create(data: CreateRequest) {
\t\treturn await this.{{datasourceVar}}.createRequest<I{{name}}>(({ http }) => 
\t\t\thttp.post(this.endpoint, { json: data })
\t\t);
\t}
\t
\tpublic async update(id: number, data: UpdateRequest) {
\t\treturn await this.{{datasourceVar}}.createRequest<I{{name}}>(({ http }) => 
\t\t\thttp.put(\`\${this.endpoint}/\${id}\`, { json: data })
\t\t);
\t}
\t
\tpublic async remove(id: number) {
\t\treturn await this.{{datasourceVar}}.createRequest<never>(({ http }) => 
\t\t\thttp.delete(\`\${this.endpoint}/\${id}\`)
\t\t);
\t}
}`;

const serviceTemplate = `import { ClassMirror } from '@azure-net/kit';
import { {{name}}Repository } from '../../Infrastructure/Repositories/index.js';

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
import type { I{{name}}CreateRequest } from '../../Domain/Ports/{{name}}/index.js';

export const Create{{name}}Schema = {{schemaFactory}}<I{{name}}CreateRequest>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const updateSchemaTemplate = `import { {{schemaFactory}} } from '{{schemaImport}}';
import type { I{{name}}UpdateRequest } from '../../Domain/Ports/{{name}}/index.js';

export const Update{{name}}Schema = {{schemaFactory}}<I{{name}}UpdateRequest>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const presenterTemplate = `import { {{presenterFactory}} } from '{{presenterImport}}';
import { ApplicationProvider } from '../../Application/index.js';
import { Create{{name}}Schema, Update{{name}}Schema } from '../Schemas/index.js';
import type { I{{name}}CreateRequest, I{{name}}UpdateRequest, I{{name}}CollectionQuery } from '../../Domain/Ports/{{name}}/index.js';

export const {{contextName}}{{name}}Presenter = {{presenterFactory}}('{{contextName}}{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\tconst { {{name}}Service } = ApplicationProvider();
\t
\tconst collection = async (queryParams?: I{{name}}CollectionQuery) => 
\t\tawait createAsyncResource({{name}}Service.collection(queryParams));
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
        path.join(process.cwd(), 'src/app/core/Datasources')
    );
    const contextDatasources = await getAvailableFiles(
        path.join(contextPath, 'Infrastructure', 'Datasources')
    );

    const allDatasources = [
        ...coreDatasources.map(d => ({ title: `${d}Datasource (core)`, value: { name: `${d}Datasource`, from: 'core' } })),
        ...contextDatasources.map(d => ({ title: `${d}Datasource (${context})`, value: { name: `${d}Datasource`, from: context } }))
    ];

    const { datasource } = await prompts({
        type: 'select',
        name: 'datasource',
        message: 'Select datasource:',
        choices: allDatasources
    });

    // Get schema and presenter factories
    const coreSchemas = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Schemas')
    );

    const { schemaType } = await prompts({
        type: 'select',
        name: 'schemaType',
        message: 'Select schema factory:',
        choices: [
            { title: 'Use schema from package', value: 'package' },
            ...coreSchemas.map(s => ({ title: `Use ${s} from core`, value: s }))
        ]
    });

    const corePresenters = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Presenters')
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

    // 2. Create Ports (Requests/Responses)
    const portsPath = path.join(contextPath, 'Domain', 'Ports', pascalName);
    await writeIfNotExists(
        path.join(portsPath, 'index.ts'),
        requestTemplate.replace(/{{name}}/g, pascalName)
    );

    // 3. Create Repository
    const repoPath = path.join(contextPath, 'Infrastructure', 'Repositories');
    const datasourceImport = datasource.from === 'core'
        ? '$core/Datasources/index.js'
        : '../Datasources/index.js';

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

    // 4. Create Service
    const servicePath = path.join(contextPath, 'Application', 'Services');
    await writeIfNotExists(
        path.join(servicePath, `${pascalName}Service.ts`),
        serviceTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{camelName}}/g, camelName)
    );
    await updateIndexTs(servicePath);

    // 5. Create Schemas
    const schemaPath = path.join(contextPath, 'Delivery', 'Schemas');
    const schemaFactory = schemaType === 'package' ? 'schema' : schemaType;
    const schemaImport = schemaType === 'package'
        ? '@azure-net/kit'
        : '$core/Schemas/index.js';

    await writeIfNotExists(
        path.join(schemaPath, `Create${pascalName}Schema.ts`),
        createSchemaTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{schemaFactory}}/g, schemaFactory)
            .replace(/{{schemaImport}}/g, schemaImport)
    );

    await writeIfNotExists(
        path.join(schemaPath, `Update${pascalName}Schema.ts`),
        updateSchemaTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{schemaFactory}}/g, schemaFactory)
            .replace(/{{schemaImport}}/g, schemaImport)
    );
    await updateIndexTs(schemaPath);

    // 6. Create Presenter
    const presenterPath = path.join(contextPath, 'Delivery', 'Presenters');
    const presenterFactory = presenterType === 'package' ? 'createPresenter' : presenterType;
    const presenterImport = presenterType === 'package'
        ? '@azure-net/kit'
        : '$core/Presenters/index.js';

    await writeIfNotExists(
        path.join(presenterPath, `${pascalName}Presenter.ts`),
        presenterTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{contextName}}/g, contextName)
            .replace(/{{presenterFactory}}/g, presenterFactory)
            .replace(/{{presenterImport}}/g, presenterImport)
    );
    await updateIndexTs(presenterPath);

    // 7. Setup Providers
    // Ensure DatasourceProvider
    await ensureProvider(context, 'Infrastructure', { datasource: datasource.name });

    // Ensure InfrastructureProvider and add repository
    const infraProvider = await ensureProvider(context, 'Infrastructure', {});
    await addToProvider(
        infraProvider.path,
        `${pascalName}Repository`,
        '../Repositories/index.js'
    );

    // Update provider with datasource dependency
    let infraContent = await fs.readFile(infraProvider.path, 'utf-8');
    const repoFactory = `${pascalName}Repository: () => new ${pascalName}Repository()`;
    const repoWithDatasource = `${pascalName}Repository: () => new ${pascalName}Repository(DatasourceProvider.${datasource.name})`;
    infraContent = infraContent.replace(repoFactory, repoWithDatasource);
    await fs.writeFile(infraProvider.path, infraContent, 'utf-8');

    // Ensure ApplicationProvider and add service
    const appProvider = await ensureProvider(context, 'Application', { infrastructure: true });
    await addToProvider(
        appProvider.path,
        `${pascalName}Service`,
        '../Services/index.js'
    );

    // Update provider with repository dependency
    let appContent = await fs.readFile(appProvider.path, 'utf-8');
    const serviceFactory = `${pascalName}Service: () => new ${pascalName}Service()`;
    const serviceWithRepo = `${pascalName}Service: () => new ${pascalName}Service(InfrastructureProvider.${pascalName}Repository)`;
    appContent = appContent.replace(serviceFactory, serviceWithRepo);
    await fs.writeFile(appProvider.path, appContent, 'utf-8');

    console.log(`✅ CRUD module for ${pascalName} created successfully!`);
}