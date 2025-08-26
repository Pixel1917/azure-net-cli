import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getApplicationProviderServices, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const presenterWithSharedTemplate = `import { {{presenterFactory}} } from '$shared/Presenter';
import { ApplicationProvider } from '\${{context}}/Application';

export const {{name}}Presenter = {{presenterFactory}}('{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\tconst { {{serviceName}} } = ApplicationProvider();
\t
{{methods}}
\t
\treturn { {{exports}} };
});`;

const presenterWithPackageTemplate = `import { createPresenter } from '@azure-net/kit';
import { ApplicationProvider } from '\${{context}}/Application';

export const {{name}}Presenter = createPresenter('{{name}}Presenter', () => {
\tconst { {{serviceName}} } = ApplicationProvider();
\t
{{methods}}
\t
\treturn { {{exports}} };
});`;

export default async function generatePresenterByService() {
    const context = await selectContext('Select context:');

    // Get available services from ApplicationProvider
    const services = await getApplicationProviderServices(context);

    if (services.length === 0) {
        console.error('❌ No services found in ApplicationProvider. Add services manually first.');
        return;
    }

    const { service } = await prompts({
        type: 'select',
        name: 'service',
        message: 'Select service to create presenter from:',
        choices: services.map(s => ({ title: s, value: s }))
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

    const entityName = service.replace('Service', '');
    const pascalName = toPascalCase(entityName);
    const contextPath = getContextPath(context);
    const deliveryModulePath = path.join(contextPath, 'Delivery', pascalName);

    // Generate method declarations based on common service patterns
    const commonMethods = ['collection', 'resource', 'create', 'update', 'remove'];

    const methods = presenterType === 'package'
        ? commonMethods.map(m => `\tconst ${m} = async (...args: Parameters<typeof ${service}['${m}']>) => 
\t\tawait ${service}.${m}(...args);`).join('\n\n')
        : commonMethods.map(m => `\tconst ${m} = async (...args: Parameters<typeof ${service}['${m}']>) => 
\t\tawait createAsyncResource(${service}.${m}(...args));`).join('\n\n');

    const exports = commonMethods.join(', ');

    const template = presenterType === 'package'
        ? presenterWithPackageTemplate
        : presenterWithSharedTemplate;

    const presenterFactory = presenterType === 'package' ? 'createPresenter' : presenterType;

    await writeIfNotExists(
        path.join(deliveryModulePath, `${pascalName}Presenter.ts`),
        template
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{serviceName}}/g, service)
            .replace(/{{presenterFactory}}/g, presenterFactory)
            .replace(/{{methods}}/g, methods)
            .replace(/{{exports}}/g, exports)
    );

    // Create module index
    await writeIfNotExists(
        path.join(deliveryModulePath, 'index.ts'),
        `export * from './${pascalName}Presenter';`
    );

    console.log(`✅ Presenter for ${service} created successfully!`);
    console.log(`\n💡 Note: Methods are based on common patterns. Adjust them to match your actual service methods.`);
}