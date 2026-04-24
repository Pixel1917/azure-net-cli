import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists } from '../utils/fileUtils.js';

const parseLocales = (rawLocales: string): string[] => {
	const parsed = String(rawLocales ?? '')
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);

	const unique = Array.from(new Set(parsed));
	return unique.length ? unique : ['en', 'ru'];
};

const createTranslationIndexTemplate = (defaultLocale: string): string => `import { messages } from './locales/index.js';
import { createTranslations, type Path } from '@azure-net/kit/i18n';

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

const createLocalesIndexTemplate = (locales: string[]): string => {
	const lines = locales.map((locale) => `\t${locale}: () => import('./${locale}/index.js').then((res) => res.default)`);
	return `export const messages = {\n${lines.join(',\n')}\n};\n`;
};

const createLocaleTemplate = (): string => `export default {
\ttest: 'test'
};
`;

export default async function createTranslationManager(): Promise<void> {
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

	const translationRoot = path.join(process.cwd(), 'src', 'core', 'translation');
	const localesRoot = path.join(translationRoot, 'locales');
	await fs.mkdir(localesRoot, { recursive: true });

	await writeIfNotExists(path.join(translationRoot, 'index.ts'), createTranslationIndexTemplate(selectedDefaultLocale));
	await writeIfNotExists(path.join(localesRoot, 'index.ts'), createLocalesIndexTemplate(locales));

	for (const locale of locales) {
		const localeDir = path.join(localesRoot, locale);
		await fs.mkdir(localeDir, { recursive: true });
		await writeIfNotExists(path.join(localeDir, 'index.ts'), createLocaleTemplate());
	}

	console.log(`✅ Translation manager created: ${translationRoot}`);
}
