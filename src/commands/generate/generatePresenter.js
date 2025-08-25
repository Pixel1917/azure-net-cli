import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const presenterWithCoreTemplate = `import { {{corePresenter}} } from '$core/Presenters/index.js';
{{serviceImport}}

export const {{contextName}}{{name}}Presenter = {{corePresenter}}('{{contextName}}{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\t{{serviceInit}}
\t
\tconst example = async () => {
\t\t// Implement presenter logic
\t\treturn {};
\t};
\t
\treturn { example };
});`;

const presenterWithPackageTemplate = `import { createPresenter } from '@azure-net/kit';
{{serviceImport}}

export const {{contextName}}{{name}}Presenter = createPresenter('{{contextName}}{{name}}Presenter', () => {
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
        message: 'Presenter name (without "Presenter" suffix):'
    });

    // Check for core presenters
    const corePresenters = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Presenters')
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
        ...services.map(s => ({ title: `${s}Service`, value: `${s}Service` }))
    ];

    const { service } = await prompts({
        type: 'select',
        name: 'service',
        message: 'Select service (optional):',
        choices: serviceChoices
    });

    const pascalName = toPascalCase(name);
    const contextName = toPascalCase(context);
    const presenterPath = path.join(contextPath, 'Delivery', 'Presenters');
    const filePath = path.join(presenterPath, `${pascalName}Presenter.ts`);

    const serviceImport = service
        ? `import { ApplicationProvider } from '../../Application/index.js';`
        : '';

    const serviceInit = service
        ? `const { ${service} } = ApplicationProvider();`
        : '';

    const content = presenterType === 'package'
        ? presenterWithPackageTemplate
            .replace(/{{contextName}}/g, contextName)
            .replace(/{{name}}/g, pascalName)
            .replace(/{{serviceImport}}/g, serviceImport)
            .replace(/{{serviceInit}}/g, serviceInit)
        : presenterWithCoreTemplate
            .replace(/{{contextName}}/g, contextName)
            .replace(/{{name}}/g, pascalName)
            .replace(/{{corePresenter}}/g, presenterType)
            .replace(/{{serviceImport}}/g, serviceImport)
            .replace(/{{serviceInit}}/g, serviceInit);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(presenterPath);

    console.log(`✅ Presenter created at ${filePath}`);
}