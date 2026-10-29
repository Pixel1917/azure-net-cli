import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toPascalCase } from '../utils/contextUtils.js';
import { writeIfNotExists, appendBarrelExports } from '../utils/fileUtils.js';
import { getLocalizationPath, getSharedState } from '../utils/sharedFoundation.js';
const parseLocales = (rawLocales) => {
    const parsed = String(rawLocales ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((locale) => /^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(locale));
    const unique = Array.from(new Set(parsed));
    return unique.length ? unique : ['en', 'ru'];
};
const createTranslationManagerTemplate = (defaultLocale) => `import { messages } from './Locales';
import { TranslationManager as KitTranslationManager } from '@azure-net/kit/i18n';
import type { Path } from '@azure-net/kit/i18n';

// Bootstrap/Bootstrap.ts: app.useTranslations(TranslationManager)
export const TranslationManager = new KitTranslationManager({
\tmessages,
\tinitLang: '${defaultLocale}',
\tinitLangFromAcceptLanguage: true,
\tcookieName: 'current-language'
});

type MessagesList = Awaited<ReturnType<(typeof messages)[keyof typeof messages]>>;
type TranslationExtended = { key: MessageKeys | string; vars?: Record<string, unknown> };

export type MessageKeys = Path<MessagesList>;
export type TranslationParam = MessageKeys | string | TranslationExtended;
export type AvailableLocales = keyof typeof messages;
`;
const createLocalesIndexTemplate = (locales) => {
    const lines = locales.map((locale) => `\t'${locale}': () => import('./${toPascalCase(locale)}').then((res) => res.default)`);
    return `export const messages = {\n${lines.join(',\n')}\n};\n`;
};
const createLocaleTemplate = () => `export default {};\n`;
export default async function createTranslationManager() {
    const { localesRaw } = await prompts({
        type: 'text',
        name: 'localesRaw',
        message: 'Enter locales (comma separated):',
        initial: 'en, ru'
    });
    const locales = parseLocales(String(localesRaw ?? 'en, ru'));
    const { defaultLocale } = await prompts({
        type: 'select',
        name: 'defaultLocale',
        message: 'Choose default locale:',
        choices: locales.map((locale) => ({ title: locale, value: locale })),
        initial: 0
    });
    const selectedDefaultLocale = String(defaultLocale ?? locales[0] ?? 'en');
    const { sharedContext } = await getSharedState();
    const translationRoot = getLocalizationPath(sharedContext.name);
    const localesRoot = path.join(translationRoot, 'Locales');
    await fs.mkdir(localesRoot, { recursive: true });
    await writeIfNotExists(path.join(translationRoot, 'TranslationManager.ts'), createTranslationManagerTemplate(selectedDefaultLocale));
    await appendBarrelExports(path.join(translationRoot, 'index.ts'), ['./TranslationManager']);
    await writeIfNotExists(path.join(localesRoot, 'index.ts'), createLocalesIndexTemplate(locales));
    for (const locale of locales) {
        const localeDir = path.join(localesRoot, toPascalCase(locale));
        await fs.mkdir(localeDir, { recursive: true });
        await writeIfNotExists(path.join(localeDir, 'index.ts'), createLocaleTemplate());
    }
    console.log("In Bootstrap/Bootstrap.ts, import { TranslationManager } from '#platform/Bootstrap/Localization' and call app.useTranslations(TranslationManager). Existing Bootstrap preserved.");
    console.log(`✅ Translation manager created: ${translationRoot}`);
}
