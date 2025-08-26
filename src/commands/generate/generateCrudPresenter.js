import prompts from 'prompts';
import path from 'path';
import fs from 'fs/promises';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles, getApplicationProviderServices } from '../../utils/contextUtils.js';
import {updateIndexTs, writeIfNotExists} from '../../utils/fileUtils.js';

const createSchemaTemplate = `import { {{schemaFactory}} } from '{{schemaImport}}';
import type { I{{name}}CreateRequest } from '\${{context}}/Domain/Ports/{{entity}}';

export const Create{{name}}Schema = {{schemaFactory}}<I{{name}}CreateRequest>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const updateSchemaTemplate = `import { {{schemaFactory}} } from '{{schemaImport}}';
import type { I{{name}}UpdateRequest } from '\${{context}}/Domain/Ports/{{entity}}';

export const Update{{name}}Schema = {{schemaFactory}}<I{{name}}UpdateRequest>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const presenterWithSharedTemplate = `import { {{presenterFactory}} } from '$shared/Presenter';
import { ApplicationProvider } from '\${{context}}/Application';
import { Create{{name}}Schema, Update{{name}}Schema } from './Schema';
import type { 
\tI{{name}}CollectionQuery,
\tI{{name}}CreateRequest,
\tI{{name}}UpdateRequest
} from '\${{context}}/Domain/Ports/{{name}}';

export const {{name}}Presenter = {{presenterFactory}}('{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\tconst { {{serviceName}} } = ApplicationProvider();
\t
\tconst collection = async (query?: I{{name}}CollectionQuery) => 
\t\tawait createAsyncResource({{serviceName}}.collection(query));
\t
\tconst resource = async (id: number) => 
\t\tawait createAsyncResource({{serviceName}}.resource(id));
\t
\tconst create = async (request: I{{name}}CreateRequest) =>
\t\tawait createAsyncAction({{serviceName}}.create(Create{{name}}Schema.from(request).json()));
\t
\tconst update = async (id: number, request: I{{name}}UpdateRequest) =>
\t\tawait createAsyncAction({{serviceName}}.update(id, Update{{name}}Schema.from(request).json()));
\t
\tconst remove = async (id: number) => 
\t\tawait createAsyncAction({{serviceName}}.remove(id));
\t
\treturn { collection, resource, create, update, remove };
});`;

const presenterWithoutSharedTemplate = `import { createPresenter } from '@azure-net/kit';
import { ApplicationProvider } from '\${{context}}/Application';
import { Create{{name}}Schema, Update{{name}}Schema } from './Schema';
import type { 
\tI{{name}}CollectionQuery,
\tI{{name}}CreateRequest,
\tI{{name}}UpdateRequest
} from '\${{context}}/Domain/Ports/{{name}}';

export const {{name}}Presenter = createPresenter('{{name}}Presenter', () => {
\tconst { {{serviceName}} } = ApplicationProvider();
\t
\tconst collection = async (query?: I{{name}}CollectionQuery) => 
\t\tawait {{serviceName}}.collection(query);
\t
\tconst resource = async (id: number) => 
\t\tawait {{serviceName}}.resource(id);
\t
\tconst create = async (request: I{{name}}CreateRequest) =>
\t\tawait {{serviceName}}.create(Create{{name}}Schema.from(request).json());
\t
\tconst update = async (id: number, request: I{{name}}UpdateRequest) =>
\t\tawait {{serviceName}}.update(id, Update{{name}}Schema.from(request).json());
\t
\tconst remove = async (id: number) => 
\t\tawait {{serviceName}}.remove(id);
\t
\treturn { collection, resource, create, update, remove };
});`;

export default async function generateCrudPresenter() {
    const context = await selectContext('Select context for CRUD presenter:');

    // Get available services from ApplicationProvider
    const services = await getApplicationProviderServices(context);

    if (services.length === 0) {
        console.error('❌ No services found in ApplicationProvider. Add services manually first.');
        return;
    }

    const { service } = await prompts({
        type: 'select',
        name: 'service',
        message: 'Select service for CRUD:',
        choices: services.map(s => ({ title: s, value: s }))
    });

    // Extract entity name from service name
    const entityName = service.replace('Service', '');
    const pascalName = toPascalCase(entityName);

    // Get schema factory
    const sharedSchemas = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/shared/Schema')
    );

    const { schemaType } = await prompts({
        type: 'select',
        name: 'schemaType',
        message: 'Select schema factory:',
        choices: [
            { title: 'Use createSchemaFactory from package', value: 'package' },
            ...sharedSchemas.map(s => ({ title: `Use ${s} from shared`, value: s }))
        ]
    });

    // Get presenter factory
    const sharedPresenters = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/shared/Presenter')
    );

    const { presenterType } = await prompts({
        type: 'select',
        name: 'presenterType',
        message: 'Select presenter factory:',
        choices: [
            { title: 'Use createPresenter from package', value: 'package' },
            ...sharedPresenters.map(p => ({ title: `Use ${p} from shared`, value: p }))
        ]
    });

    const contextPath = getContextPath(context);
    const deliveryModulePath = path.join(contextPath, 'Delivery', pascalName);
    const schemaPath = path.join(deliveryModulePath, 'Schema');

    console.log('\n🚀 Generating CRUD presenter...\n');

    // Create schemas
    const schemaFactory = schemaType === 'package' ? 'Schema' : schemaType;
    const schemaImport = schemaType === 'package'
        ? '@azure-net/kit'
        : '$shared/Schema';

    if (schemaType === 'package') {
        const schemaImportFull = `import { createSchemaFactory } from '@azure-net/kit';
import { createRules, validationMessagesI18n } from '@azure-net/kit/schema';

const Schema = createSchemaFactory(createRules(validationMessagesI18n));`;

        await writeIfNotExists(
            path.join(schemaPath, `Create${pascalName}Schema.ts`),
            schemaImportFull + '\n' + createSchemaTemplate
                .replace('import { {{schemaFactory}} } from \'{{schemaImport}}\';\n', '')
                .replace(/{{name}}/g, pascalName)
                .replace(/{{context}}/g, context)
                .replace(/{{entity}}/g, pascalName)
                .replace(/{{schemaFactory}}/g, 'Schema')
        );

        await writeIfNotExists(
            path.join(schemaPath, `Update${pascalName}Schema.ts`),
            schemaImportFull + '\n' + updateSchemaTemplate
                .replace('import { {{schemaFactory}} } from \'{{schemaImport}}\';\n', '')
                .replace(/{{name}}/g, pascalName)
                .replace(/{{context}}/g, context)
                .replace(/{{entity}}/g, pascalName)
                .replace(/{{schemaFactory}}/g, 'Schema')
        );
    } else {
        await writeIfNotExists(
            path.join(schemaPath, `Create${pascalName}Schema.ts`),
            createSchemaTemplate
                .replace(/{{name}}/g, pascalName)
                .replace(/{{context}}/g, context)
                .replace(/{{entity}}/g, pascalName)
                .replace(/{{schemaFactory}}/g, schemaFactory)
                .replace(/{{schemaImport}}/g, schemaImport)
        );

        await writeIfNotExists(
            path.join(schemaPath, `Update${pascalName}Schema.ts`),
            updateSchemaTemplate
                .replace(/{{name}}/g, pascalName)
                .replace(/{{context}}/g, context)
                .replace(/{{entity}}/g, pascalName)
                .replace(/{{schemaFactory}}/g, schemaFactory)
                .replace(/{{schemaImport}}/g, schemaImport)
        );
    }
    await updateIndexTs(schemaPath);

    // Create Presenter
    const presenterTemplate = presenterType === 'package'
        ? presenterWithoutSharedTemplate
        : presenterWithSharedTemplate;

    const presenterFactory = presenterType === 'package' ? 'createPresenter' : presenterType;

    await writeIfNotExists(
        path.join(deliveryModulePath, `${pascalName}Presenter.ts`),
        presenterTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{serviceName}}/g, service)
            .replace(/{{presenterFactory}}/g, presenterFactory)
    );

    // Create module index
    await writeIfNotExists(
        path.join(deliveryModulePath, 'index.ts'),
        `export * from './${pascalName}Presenter';\nexport * from './Schema';`
    );

    console.log(`✅ CRUD presenter for ${pascalName} created successfully!`);
}