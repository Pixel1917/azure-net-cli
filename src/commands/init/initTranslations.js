import { writeIfNotExists } from '../../utils/fileUtils.js';
import path from 'path';

const translationsPath = path.join(process.cwd(), 'src/app/shared/Translation');

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

    console.log('✅ Translations initialized');
}