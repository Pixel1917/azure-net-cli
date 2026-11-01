import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateAppConfiguration } from '../src/migrate/appConfiguration.js';
const migrate = (body) => migrateAppConfiguration(`import { createApp as make } from '@azure-net/kit';\n${body}`, 'app.ts');
test('splits known chains in order without changing inner async hook returns', () => {
	const result = migrate(
		`make(app => app.useServer(async ({ event, resolve }) => { return resolve(event); }).useClient(() => { return Promise.resolve(); }));`
	);
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /return resolve\(event\);/);
	assert.match(result.content, /return Promise.resolve\(\);/);
	assert.match(result.content, /\);\s*app.useClient/);
	assert.deepEqual(migrateAppConfiguration(result.content, 'app.ts'), result);
});
test('removes only the final configurator return and supports function callbacks', () => {
	const result = migrate(
		`make(function(app) { app.useClient(() => { return; }); return app.useBoot(() => undefined).useTranslations(manager); });`
	);
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /return;/);
	assert.doesNotMatch(result.content, /return app|\)\.use/);
});
test('preserves unsupported, async and conditional callbacks for manual review', () => {
	for (const body of [
		'async app => app.useClient(hook)',
		'app => app.custom(hook).useClient(hook)',
		'app => { if (flag) return app; return app.useClient(hook); }',
		'app => app?.useClient(hook)',
		'configure'
	]) {
		const result = migrate(`make(${body});`);
		assert.ok(result.issues.length, body);
		assert.ok(result.content.endsWith(`make(${body});`));
	}
});
test('does not rewrite shadowed createApp imports or unrelated calls', () => {
	const result = migrate(`function other(make) { return make(app => app.useClient(hook)); } unrelated(app => app.useClient(hook));`);
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /make\(app => app.useClient\(hook\)\)/);
});
test('empty callbacks, comments and bare app returns', () => {
	const result = migrate(`make(app => { /* keep */ return app; });`);
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /\/\* keep \*\//);
	assert.doesNotMatch(result.content, /return app/);
	assert.deepEqual(migrate('make(app => {});').issues, []);
});

test('leaves imperative configuration with local setup alone without false warnings', () => {
	const body = `make(app => { const handler = async ({ event, resolve }) => { return resolve(event); }; app.useServer(handler); if (enabled) app.useClient(client); });`;
	const result = migrate(body);
	assert.deepEqual(result.issues, []);
	assert.ok(result.content.endsWith(body));
});
test('fast path leaves files without createApp unchanged', () => {
	const input = 'export const value = 1;';
	assert.deepEqual(migrateAppConfiguration(input, 'plain.ts'), { content: input, issues: [] });
});
