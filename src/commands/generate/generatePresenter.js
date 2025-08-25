import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const presenterWithCoreTemplate = `import { {{corePresenter}} } from '$core/Presenter';
{{serviceImport}}

export const {{name}}Presenter = {{corePresenter}}('{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\t{{serviceInit}}
\t
\tconst example = async () => {
\t\t// Implement presenter logic
\t\treturn await createAsyncResource(Promise.resolve({}));
\t};
\t
\treturn { example };
});`;

const presenterWithPackageTemplate = `import { createPresenter } from '@azure-net/kit';
{{serviceImport}}

export const {{name}}Presenter = createPresenter('{{name}}Presenter', () => {
\t{{serviceInit}}
\t
\tconst example = async () => {
\t\t// Implement presenter logic
\t\treturn {};
\t};
\t
\treturn { example };
});`;

export default async function generatePresenter() {
    const context = await selectContext('Select context for presenter:');

    if (context === 'core') {
        console.error('❌ Cannot create presenter in core. Choose a specific context.');
        return;
    }

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Module name (will create folder in Delivery):'
    });

    // Check for core presenters
    const corePresenters = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Presenter')
    );

    const presenterChoices = [
        { title: 'Use createPresenter from package', value: 'package' },
        ...corePresenters.map(p => ({ title: `Use ${p} from core`, value: p }))
    ];

    const { presenterType } = await prompts({
        type: 'select',
        name: 'presenterType',
        message: 'Select presenter factory:',
        choices: presenterChoices
    });

    // Get available services
    const contextPath = getContextPath(context);
    const services = await getAvailableFiles(
        path.join(contextPath, 'Application', 'Services')
    );

    const serviceChoices = [
        { title: 'Without service', value: null },
        ...services.map(s => ({ title: `${s}`, value: s }))
    ];

    const { service } = await prompts({
        type: 'select',
        name: 'service',
        message: 'Select service (optional):',
        choices: serviceChoices
    });

    const pascalName = toPascalCase(name);
    const modulePath = path.join(contextPath, 'Delivery', pascalName);
    const filePath = path.join(modulePath, `${pascalName}Presenter.ts`);

    const serviceImport = service
        ? `import { ApplicationProvider } from '$${context}/Application';`
        : '';

    const serviceInit = service
        ? `const { ${service} } = ApplicationProvider();`
        : '';

    const content = presenterType === 'package'
        ? presenterWithPackageTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{serviceImport}}/g, serviceImport)
            .replace(/{{serviceInit}}/g, serviceInit)
        : presenterWithCoreTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{corePresenter}}/g, presenterType)
            .replace(/{{serviceImport}}/g, serviceImport)
            .replace(/{{serviceInit}}/g, serviceInit);

    await writeIfNotExists(filePath, content);
    await writeIfNotExists(
        path.join(modulePath, 'index.ts'),
        `export * from './${pascalName}Presenter';`
    );

    console.log(`✅ Presenter created at ${filePath}`);
}