import prompts from 'prompts';
import path from 'path';
import fs from 'fs/promises';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const presenterWithSharedTemplate = `import { {{sharedPresenter}} } from '$shared/Presenter';
import { ApplicationProvider } from '\${{context}}/Application';

export const {{name}}Presenter = {{sharedPresenter}}('{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\tconst { /* extract services from ApplicationProvider */ } = ApplicationProvider();
\t
\tconst example = async () => {
\t\t// Using async helpers from shared presenter factory
\t\treturn await createAsyncResource(Promise.resolve({}));
\t};
\t
\treturn { example };
});`;

const presenterWithPackageTemplate = `import { createPresenter } from '@azure-net/kit';
import { ApplicationProvider } from '\${{context}}/Application';

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
        message: 'Module name (will create folder in Delivery):'
    });

    // Check for shared presenters
    const sharedPresenters = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/shared/Presenter')
    );

    const presenterChoices = [
        { title: 'Use createPresenter from package', value: 'package' },
        ...sharedPresenters.map(p => ({ title: `Use ${p} from shared`, value: p }))
    ];

    const { presenterType } = await prompts({
        type: 'select',
        name: 'presenterType',
        message: 'Select presenter factory:',
        choices: presenterChoices
    });

    const pascalName = toPascalCase(name);
    const contextPath = getContextPath(context);
    const modulePath = path.join(contextPath, 'Delivery', pascalName);
    const filePath = path.join(modulePath, `${pascalName}Presenter.ts`);

    const content = presenterType === 'package'
        ? presenterWithPackageTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
        : presenterWithSharedTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{sharedPresenter}}/g, presenterType)
            .replace(/{{context}}/g, context);

    await writeIfNotExists(filePath, content);
    await writeIfNotExists(
        path.join(modulePath, 'index.ts'),
        `export * from './${pascalName}Presenter';`
    );

    console.log(`✅ Presenter created at ${filePath}`);
    console.log(`\n💡 Remember to extract needed services from ApplicationProvider in the presenter.`);
}