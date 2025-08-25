import { writeIfNotExists, updateIndexTs, injectIntoFile } from '../../utils/fileUtils.js';
import path from 'path';

const translationsPath = path.join(process.cwd(), 'src/app/core/Translation');
const layoutServerPath = path.join(process.cwd(), 'src/routes/+layout.server.ts');
const layoutTsPath = path.join(process.cwd(), 'src/routes/+layout.ts');

const translationProviderTemplate = `import { messages } from './Locales';
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
\ten: () => import('./en').then((res) => res.default),
\tru: () => import('./ru').then((res) => res.default)
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

    // Add to hooks.server.ts
    await injectIntoFile(
        path.join(process.cwd(), 'src/hooks.server.ts'),
        'import',
        `import { Translation } from '$core';`,
        'before'
    );

    await injectIntoFile(
        path.join(process.cwd(), 'src/hooks.server.ts'),
        'await serverMiddleware();',
        `\t\t\tconst { preloadTranslation, applyHtmlLocaleAttr } = Translation();\n\t\t\tawait preloadTranslation(edgesEvent);`,
        'after'
    );

    await injectIntoFile(
        path.join(process.cwd(), 'src/hooks.server.ts'),
        'transformPageChunk: ({ html })',
        ' => {\n\t\t\t\tconst serialized = serialize(html);\n\t\t\t\treturn applyHtmlLocaleAttr(serialized);\n\t\t\t}',
        'after'
    );

    // Add to layout files
    await injectIntoFile(
        layoutServerPath,
        'export const load',
        `\treturn { lang: locals.lang };`,
        'after'
    );

    await injectIntoFile(
        layoutTsPath,
        'import',
        `import { Translation } from '$core';\nimport { browser } from '$app/environment';`,
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