import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateCoreIndex } from '../../utils/fileUtils.js';

const presenterWithCoreTemplate = `import { {{corePresenter}} } from '$core/presenters';
import { ApplicationProvider } from '\${{context}}/application';

export const {{name}}Presenter = {{corePresenter}}('{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\tconst { /* extract services from ApplicationProvider */ } = ApplicationProvider();
\t
\tconst example = async () => {
\t\t// Using async helpers from core presenter factory
\t\treturn await createAsyncResource(Promise.resolve({}));
\t};
\t
\treturn { example };
});`;

const presenterWithPackageTemplate = `import { createPresenter } from '@azure-net/kit';
import { ApplicationProvider } from '\${{context}}/application';

export const {{name}}Presenter = createPresenter('{{name}}Presenter', () => {
\tconst { /* extract services from ApplicationProvider */ } = ApplicationProvider();
\t
\tconst example = async () => {
\t\t// Direct method without async helpers
\t\treturn await Promise.resolve({});
\t};
\t
\treturn { example };
});`;

export default async function generatePresenter() {
    const context = await selectContext('Select context for presenter:');

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Module name (will create folder in delivery):'
    });

    // Check for core presenters
    const corePresenters = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/presenters')
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

    const pascalName = toPascalCase(name);
    const moduleLower = pascalName.toLowerCase();
    const contextPath = getContextPath(context);
    const modulePath = path.join(contextPath, 'delivery', moduleLower);
    const filePath = path.join(modulePath, `${pascalName}Presenter.ts`);

    const content = presenterType === 'package'
        ? presenterWithPackageTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
        : presenterWithCoreTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{corePresenter}}/g, presenterType)
            .replace(/{{context}}/g, context);

    await writeIfNotExists(filePath, content);
    await writeIfNotExists(
        path.join(modulePath, 'index.ts'),
        `export * from './${pascalName}Presenter';`
    );

    // Update core index
    await updateCoreIndex();

    console.log(`✅ Presenter created at ${filePath}`);
    console.log(`\n💡 Remember to extract needed services from ApplicationProvider in the presenter.`);
}