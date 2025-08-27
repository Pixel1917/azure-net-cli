import { writeIfNotExists, updateCoreIndex } from '../../utils/fileUtils.js';
import path from 'path';

const translationsPath = path.join(process.cwd(), 'src/app/core/translations');

const translationProviderTemplate = `import { messages } from './locales';
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
        path.join(translationsPath, 'locales', 'en.ts'),
        enLocaleTemplate
    );

    await writeIfNotExists(
        path.join(translationsPath, 'locales', 'ru.ts'),
        ruLocaleTemplate
    );

    await writeIfNotExists(
        path.join(translationsPath, 'locales', 'index.ts'),
        localesIndexTemplate
    );

    // Update core index
    await updateCoreIndex();

    console.log('✅ Translations initialized');
}