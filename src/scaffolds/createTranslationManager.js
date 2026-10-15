import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import ts from 'typescript';
import { formatConfig } from '../utils/viteConfig.js';
import { toPascalCase } from '../utils/contextUtils.js';
import { writeIfNotExists } from '../utils/fileUtils.js';
import { getLocalizationPath, getSharedState } from '../utils/sharedFoundation.js';
const parseLocales = (rawLocales) => {
    const parsed = String(rawLocales ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((locale) => /^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(locale));
    const unique = Array.from(new Set(parsed));
    return unique.length ? unique : ['en', 'ru'];
};
const createTranslationIndexTemplate = (defaultLocale) => `import { messages } from './Locales';
import { createTranslations } from '@azure-net/kit/i18n';
import type { Path } from '@azure-net/kit/i18n';

// program.ts: createApp((app) => app.useTranslations(TranslationManager))
export const TranslationManager = createTranslations({
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
const createLocaleTemplate = () => `export default {
\ttest: 'test'
};
`;
async function connectTranslations(translationRoot) {
    const file = path.join(process.cwd(), 'src/program.ts');
    let specifier = path.relative(path.dirname(file), translationRoot).split(path.sep).join('/');
    if (!specifier.startsWith('.'))
        specifier = `./${specifier}`;
    let content;
    try {
        content = await fs.readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        content = "import { createApp } from '@azure-net/kit';\nexport const { register } = createApp((app) => app);\n";
    }
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    let body;
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createApp') {
            const callback = node.arguments[0];
            if (callback &&
                ts.isArrowFunction(callback) &&
                ts.isIdentifier(callback.body) &&
                callback.parameters[0]?.name.getText(source) === callback.body.text)
                body = callback.body;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    // Only modify the empty generated bootstrap, not application-specific pipelines/imports.
    if (!body || /\bTranslationManager\b/.test(content)) {
        console.log(`Connect translations in ${file}: app.useTranslations(TranslationManager), imported from '${specifier}'. Existing bootstrap preserved.`);
        return;
    }
    content =
        `import { TranslationManager } from '${specifier}';\n` +
            content.slice(0, body.end) +
            '.useTranslations(TranslationManager)' +
            content.slice(body.end);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await formatConfig(content, file));
}
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
    await writeIfNotExists(path.join(translationRoot, 'index.ts'), createTranslationIndexTemplate(selectedDefaultLocale));
    await writeIfNotExists(path.join(localesRoot, 'index.ts'), createLocalesIndexTemplate(locales));
    for (const locale of locales) {
        const localeDir = path.join(localesRoot, toPascalCase(locale));
        await fs.mkdir(localeDir, { recursive: true });
        await writeIfNotExists(path.join(localeDir, 'index.ts'), createLocaleTemplate());
    }
    await connectTranslations(translationRoot);
    console.log(`✅ Translation manager created: ${translationRoot}`);
}
