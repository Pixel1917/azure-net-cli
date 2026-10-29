import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import ts from 'typescript';
// Test current sources without building or modifying generated JavaScript.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
			return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		const result = next(url, context);
		if (!url.endsWith('.ts')) return result;
		return {
			format: 'module',
			source: ts.transpileModule(String(result.source), {
				compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
			}).outputText,
			shortCircuit: true
		};
	}
});
const { mergeKitViteConfig, formatConfig, configureKitProject, readStaticAliases } = await import('../src/utils/viteConfig.ts');
const { registerDatasource } = await import('../src/scaffolds/registerDatasource.ts');
const { default: installFresh } = await import('../src/install/installFresh.ts');
import prompts from 'prompts';
const aliases = { '#contexts': './src/app/Contexts' };
const vite =
	"import { sveltekit } from '@sveltejs/kit/vite'; import { defineConfig } from 'vite'; export default defineConfig({plugins:[sveltekit()]});";
const evaluate = (source) =>
	new Function('sveltekit', 'defineConfig', 'adapter', source.replace(/import[^;]+;/g, '').replace('export default', 'return'))(
		(x) => x,
		(x) => x,
		() => 'adapter'
	).plugins[0];
async function fixture(fn) {
	const cwd = process.cwd();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-kit3-'));
	process.chdir(dir);
	try {
		await fn(dir);
	} finally {
		process.chdir(cwd);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test('Vite options preserve compiler options, adapter and formatting; repeated edit is stable', async () => {
	const source = vite.replace(
		'sveltekit()',
		'sveltekit({adapter: adapter(), compilerOptions: {runes:true}, alias: {$custom:"./custom"} // keep comment\n})'
	);
	const first = await formatConfig(mergeKitViteConfig(source, aliases), '/tmp/vite.config.ts');
	const second = await formatConfig(mergeKitViteConfig(first, aliases), '/tmp/vite.config.ts');
	assert.equal(first, second);
	assert.match(first, /keep comment/);
	assert.deepEqual(evaluate(first), { adapter: 'adapter', compilerOptions: { runes: true }, alias: { $custom: './custom', ...aliases } });
});

test('supports aliased sveltekit import, callback Vite config and local options variable', () => {
	const source =
		"import { sveltekit as kit } from '@sveltejs/kit/vite'; const options={compilerOptions:{runes:true}}; export default () => ({plugins:[kit(options)]});";
	const output = mergeKitViteConfig(source, aliases);
	assert.match(output, /kit\(options\)/);
	assert.deepEqual(readStaticAliases(output), aliases);
});

test('converts legacy kit options without changing compiler options or polling defaults', () => {
	const old =
		"import adapter from '@sveltejs/adapter-node'; const config={compilerOptions:{runes:true}, kit:{adapter:adapter(), files:{lib:'src/lib',routes:'src/pages'}, experimental:{handleRenderingErrors:true,instrumentation:true,tracing:{server:true},remoteFunctions:true},preloadStrategy:'js',prerender:{origin:'https://example.com',entries:['*']},csrf:{checkOrigin:false}},vitePlugin:{inspector:true}}; export default config;";
	const config = evaluate(mergeKitViteConfig(vite, aliases, old));
	assert.equal(config.adapter, 'adapter');
	assert.equal(config.compilerOptions.runes, true);
	assert.equal(config.inspector, true);
	assert.deepEqual(config.files, { routes: 'src/pages' });
	assert.deepEqual(config.experimental, { remoteFunctions: true });
	assert.deepEqual(config.tracing, { server: true });
	assert.deepEqual(config.paths, { origin: 'https://example.com' });
	assert.deepEqual(config.csrf, { trustedOrigins: ['*'] });
	assert.equal(config.kit, undefined);
	assert.equal(config.version, undefined);
	assert.equal(config.preloadStrategy, undefined);
});

test('refuses dynamic, ambiguous or conflicting configs rather than losing settings', () => {
	assert.throws(() => mergeKitViteConfig(vite.replace('sveltekit()', 'sveltekit(makeOptions())'), aliases), /dynamic/);
	assert.throws(() => mergeKitViteConfig(vite.replace('sveltekit()', 'sveltekit(),sveltekit()'), aliases), /exactly one/);
	assert.throws(
		() => mergeKitViteConfig(vite.replace('sveltekit()', 'sveltekit({adapter: adapter()})'), aliases, 'export default {};'),
		/Both Vite/
	);
	assert.throws(() => mergeKitViteConfig(vite, aliases, 'export default {kit:{csrf:{checkOrigin:env}}};'), /Dynamic csrf/);
});

test('legacy file is backed up, removed and not recreated; respects project Prettier settings', () =>
	fixture(async () => {
		await fs.writeFile('vite.config.ts', vite);
		await fs.writeFile('.prettierrc.json', '{"singleQuote":true,"useTabs":true}');
		const old = 'export default {kit:{alias:{$old:"./old"}}};';
		await fs.writeFile('svelte.config.js', old);
		await configureKitProject();
		await assert.rejects(fs.access('svelte.config.js'));
		const output = await fs.readFile('vite.config.ts', 'utf8');
		assert.match(output, /\tplugins:/);
		const folders = await fs.readdir('.azure-net/ConfigBackups');
		assert.equal(await fs.readFile(`.azure-net/ConfigBackups/${folders[0]}/svelte.config.js`, 'utf8'), old);
		await configureKitProject();
		assert.equal(await fs.readFile('vite.config.ts', 'utf8'), output);
	}));

test('fresh install optionally creates HttpProvider and preserves existing registrations', () =>
	fixture(async () => {
		await fs.writeFile('vite.config.ts', vite);
		// Cookie, response, datasource, name, provider, schema, error handler, translations, prettier, hooks.
		prompts.inject([false, false, true, 'Api', true, false, false, false, false, false]);
		await installFresh();
		const dir = 'src/platform/Foundation/Provider';
		const output = await fs.readFile(`${dir}/HttpProvider.ts`, 'utf8');
		assert.match(output, /ApiDatasource: \(\) => new ApiDatasource/);
		assert.match(output, /CreateServiceContainer/);
		assert.deepEqual((await fs.readdir(dir)).sort(), ['HttpProvider.ts', 'index.ts']);
		await fs.writeFile(`${dir}/HttpProvider.ts`, '// user-owned DI');
		await registerDatasource('AnotherDatasource');
		assert.equal(await fs.readFile(`${dir}/HttpProvider.ts`, 'utf8'), '// user-owned DI');
		await assert.rejects(fs.access('svelte.config.js'));
	}));
