import prompts from 'prompts';
import configurePackageManager from './configurePackageManager.js';
import prettierConfig from '../plugins/prettierConfig.js';
import { addGitHooks } from '../git/hooks.js';
import initEdges from '../init/initEdges.js';
import initStructure from '../init/initStructure.js';
import { createCoreSchema, createDatasource, createProgram, createResponse, createTranslationManager, createCookieInstance, createErrorHandler } from '../scaffolds/index.js';
const runOptionalStep = async (message, action) => {
    const { confirmed } = await prompts({ type: 'confirm', name: 'confirmed', message, initial: true });
    if (!confirmed)
        return false;
    try {
        await action();
    }
    catch (error) {
        throw new Error(`Step failed: ${message}`, { cause: error });
    }
    if (process.exitCode)
        throw new Error(`Step failed: ${message}`);
    return true;
};
export default async function installFresh() {
    await initStructure();
    await configurePackageManager();
    await initEdges();
    await runOptionalStep('Create cookie instance?', createCookieInstance);
    await runOptionalStep('Create API response?', createResponse);
    await runOptionalStep('Create datasource (with optional HttpProvider)?', createDatasource);
    await runOptionalStep('Create schema factory?', createCoreSchema);
    const errorHandler = await runOptionalStep('Create error handler?', createErrorHandler);
    const translations = await runOptionalStep('Create translation manager (i18n)?', createTranslationManager);
    await createProgram({ errorHandler, translations });
    await runOptionalStep('Create Prettier configuration (no packages installed)?', prettierConfig);
    await runOptionalStep('Install git pre-commit checks?', addGitHooks);
    console.log('install fresh completed');
    console.log(`
Next steps:
1. In src/routes/+layout.svelte, merge the following into the existing instance script:

   <script lang="ts">
     import { register } from '../program';

     register();
   </script>

   Call register() synchronously during layout initialization, before resolving presenters or state classes.
   Do not put it inside onMount, an effect, or a module script. Keep your existing script and markup.
   No layout files were modified.
2. If HttpProvider was created, set httpOptions.prefixUrl in src/platform/Foundation/Provider/HttpProvider.ts to your API URL.
3. If translations were created, fill the empty dictionaries in src/platform/Bootstrap/Localization/Locales/<Locale>/index.ts.
4. Review src/platform/Bootstrap/Bootstrap.ts. Existing Bootstrap files were preserved; follow the wiring instructions above if needed.
5. From the project root, run: azure-net check project
`);
}
