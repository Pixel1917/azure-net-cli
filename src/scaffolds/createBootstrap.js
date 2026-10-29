import path from 'node:path';
import { getPlatformPath } from '../utils/architecture.js';
import { writeIfNotExists } from '../utils/fileUtils.js';
export default async function createBootstrap(options = {}) {
    const imports = [
        "import { createApp } from '@azure-net/kit';",
        ...(options.errorHandler ? ["import { ErrorHandler } from '#platform/Bootstrap/Handlers';"] : []),
        ...(options.translations ? ["import { TranslationManager } from '#platform/Bootstrap/Localization';"] : [])
    ];
    const pipeline = 'app' +
        (options.errorHandler ? '.useAzureNetKitError(ErrorHandler)' : '') +
        (options.translations ? '.useTranslations(TranslationManager)' : '');
    await writeIfNotExists(path.join(getPlatformPath(), 'Bootstrap/Bootstrap.ts'), `${imports.join('\n')}

export const AppBootstrap = () => createApp((app) => ${pipeline});
`);
}
