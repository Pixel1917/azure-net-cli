import { writeIfNotExists, updateIndexTs, injectIntoFile } from '../../utils/fileUtils.js';
import path from 'path';

const translationsPath = path.join(process.cwd(), 'src/app/core/Translations');
const layoutServerPath = path.join(process.cwd(), 'src/routes/+layout.server.ts');
const layoutTsPath = path.join(process.cwd(), 'src/routes/+layout.ts');

const translationProviderTemplate = `import { messages } from './Locales/index.js';
import { createTranslations } from '@azure-net/kit/i18n';

export const Translation = createTranslations({ 
\tmessages, 
\tinitLang: 'en', 
\tinitLangFromAcceptLanguage: true, 
\tcookieName: 'lang' 
});`;

const enLocaleTemplate = `export default {
\tapp: {
\t\ttitle: 'Application'
\t}
};`;

const ruLocaleTemplate = `export default {
\tapp: {
\t\ttitle: 'Приложение'
\t}
};`;

const localesIndexTemplate = `export const messages = {
\ten: () => import('./en.js').then((res) => res.default),
\tru: () => import('./ru.js').then((res) => res.default)
};`;

export default async function initTranslations() {
    // Create translation files
    await writeIfNotExists(
        path.join(translationsPath, 'index.ts'),
        translationProviderTemplate
    );

    await writeIfNotExists(
        path.join(translationsPath, 'Locales', 'en.ts'),
        enLocaleTemplate
    );

    await writeIfNotExists(
        path.join(translationsPath, 'Locales', 'ru.ts'),
        ruLocaleTemplate
    );

    await writeIfNotExists(
        path.join(translationsPath, 'Locales', 'index.ts'),
        localesIndexTemplate
    );

    await updateIndexTs(translationsPath);

    // Add to hooks.server.ts
    await injectIntoFile(
        path.join(process.cwd(), 'src/hooks.server.ts'),
        'import',
        `import { Translation } from '$core/Translations/index.js';`,
        'before'
    );

    await injectIntoFile(
        path.join(process.cwd(), 'src/hooks.server.ts'),
        'await serverMiddleware();',
        `\t\t\tconst { preloadTranslation, applyHtmlLocaleAttr } = Translation();\n\t\t\tawait preloadTranslation(edgesEvent);`,
        'after'
    );

    // Add to layout files
    await injectIntoFile(
        layoutServerPath,
        'export const load',
        `\treturn { lang: locals.lang, user: locals.user };`,
        'after'
    );

    await injectIntoFile(
        layoutTsPath,
        'import',
        `import { Translation } from '$core/Translations/index.js';`,
        'before'
    );

    await injectIntoFile(
        layoutTsPath,
        'export const load',
        `\tconst { syncTranslation } = Translation();\n\tif (browser) {\n\t\tawait syncTranslation({ lang: data.lang }, false);\n\t}`,
        'after'
    );

    console.log('✅ Translations initialized');
}