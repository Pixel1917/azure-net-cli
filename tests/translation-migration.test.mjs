import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { migrateTranslationsSources } from '../src/migrate/translations.js';
const resolve = (file, spec) => (spec.startsWith('.') ? path.resolve(path.dirname(file), spec + '.ts') : undefined);
const sources = () =>
	new Map([
		[
			'/src/Translations.ts',
			`import {createTranslations} from '@azure-net/edges-translations'; export const TranslationManager=createTranslations({messages,initLang:'en'});`
		],
		[
			'/src/Helper.ts',
			`import {TranslationManager} from './Translations'; export function localization(){const {preloadTranslation:preload,initializeClient,t}=TranslationManager(); return {server:async()=>{await preload();},client:()=>initializeClient(),t};}`
		],
		[
			'/src/Bootstrap.ts',
			`import {createApp} from '@azure-net/kit'; import {localization} from './Helper'; export const start=()=>createApp(app=>app.useServer(async()=>{await localization().server();}).useClientInit(()=>localization().client()));`
		]
	]);
test('connects translations before user hooks and removes obsolete methods only in known managers', () => {
	const input = sources();
	const result = migrateTranslationsSources(input, resolve);
	assert.deepEqual(result.issues, []);
	assert.match(result.updates.get('/src/Bootstrap.ts'), /app.useTranslations\(MigratedTranslationManager\).useServer/);
	assert.match(result.updates.get('/src/Translations.ts'), /@azure-net\/kit\/i18n/);
	assert.doesNotMatch(result.updates.get('/src/Helper.ts'), /preloadTranslation|initializeClient/);
	assert.match(result.updates.get('/src/Helper.ts'), /Promise.resolve\(\)/);
	const next = new Map([...input, ...result.updates]);
	assert.equal(migrateTranslationsSources(next, resolve).updates.size, 0);
});
test('does not guess between multiple managers', () => {
	const input = sources();
	input.set('/src/Other.ts', input.get('/src/Translations.ts'));
	const result = migrateTranslationsSources(input, resolve);
	assert.equal(result.updates.size, 0);
	assert.equal(result.issues.length, 2);
});
test('reports custom locale resolvers instead of silently dropping them', () => {
	const input = sources();
	input.set('/src/Helper.ts', input.get('/src/Helper.ts').replace('await preload();', 'await preload(()=>userLocale);'));
	const result = migrateTranslationsSources(input, resolve);
	assert.equal(result.updates.has('/src/Helper.ts'), false);
	assert.match(result.issues[0].reason, /Custom translation/);
});

test('translation helper shadowed function names are not replaced', () => {
	const input = sources();
	input.set('/src/Helper.ts', input.get('/src/Helper.ts') + '\nfunction other(initializeClient){return initializeClient();}');
	const result = migrateTranslationsSources(input, resolve);
	assert.deepEqual(result.issues, []);
	assert.match(result.updates.get('/src/Helper.ts'), /function other\(initializeClient\)\{return initializeClient\(\);\}/);
});

test('uses a TranslationManager instance while retaining options and direct t consumers', () => {
	const result = migrateTranslationsSources(sources(), resolve);
	assert.match(result.updates.get('/src/Translations.ts'), /TranslationManager as createTranslations/);
	assert.match(result.updates.get('/src/Translations.ts'), /new createTranslations\(\{messages,initLang:'en'\}\)/);
	assert.doesNotMatch(result.updates.get('/src/Helper.ts'), /TranslationManager\(\)/);
});

test('escaped manager references prevent partial facade and lifecycle updates', () => {
	const input = sources();
	input.set('/src/Helper.ts', input.get('/src/Helper.ts') + '\nexport const forwarded = TranslationManager;');
	const result = migrateTranslationsSources(input, resolve);
	assert.equal(result.updates.size, 0);
	assert(result.issues.some((issue) => /escapes/.test(issue.reason)));
});
