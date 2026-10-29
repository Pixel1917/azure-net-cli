import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import prompts from 'prompts';

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
const { mergeAliasesInSvelteConfig } = await import('../src/init/initAliases.ts');
const { default: initStructure } = await import('../src/init/initStructure.ts');
const { initializeConfigDefaults, loadUserConfig } = await import('../src/utils/loadConfig.ts');
const { ARCHITECTURE_ALIASES, selectWorkspace, selectScope, selectContext, discoverContexts } =
	await import('../src/utils/architecture.ts');

const read = (file) => fs.readFile(file, 'utf8');
async function fixture(action) {
	const previous = process.cwd();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-initialization-'));
	process.chdir(dir);
	try {
		await action(dir);
	} finally {
		process.chdir(previous);
		await fs.rm(dir, { recursive: true, force: true });
	}
}
async function snapshot(dir) {
	const result = {};
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		result[entry.name] = entry.isDirectory() ? await snapshot(path.join(dir, entry.name)) : await read(path.join(dir, entry.name));
	}
	return result;
}
const evaluate = (source) => new Function(source.replace('export default', 'return'))();

for (const body of [
	'export default {};',
	'export default { kit: { paths: {} // keep comment\n} };',
	'const alias = { $user: "./custom" }; export default { kit: { alias } };',
	'const common = { $user: "./custom", "#contexts": "./old" }; const config = { kit: { alias: { ...common, $other: new URL("./assets", "https://example.org").pathname // keep comment\n} } }; export default config;',
	'export default { kit: { alias: { "#contexts": "./old", $core: "./core" } } };',
	'const extra = { "#contexts": "./old" }; export default { kit: { alias: { "#contexts": "./src/app/Contexts", ...extra } } };'
]) {
	test(`alias merge is idempotent: ${body.slice(0, 65)}`, () => {
		const once = mergeAliasesInSvelteConfig(body, ARCHITECTURE_ALIASES);
		assert.equal(mergeAliasesInSvelteConfig(once, ARCHITECTURE_ALIASES), once);
		const before = evaluate(body).kit?.alias ?? {};
		assert.deepEqual(evaluate(once).kit.alias, { ...before, ...ARCHITECTURE_ALIASES });
		if (body.includes('// keep comment')) assert.ok(once.includes('// keep comment'));
	});
}

test('unresolvable Svelte config reports a clear error', () => {
	assert.throws(() => mergeAliasesInSvelteConfig('export default makeConfig();', ARCHITECTURE_ALIASES), /Cannot safely merge/);
});

for (const extension of ['ts', 'js']) {
	test(`defaults preserve legacy and custom ${extension} config, comments and functions`, () =>
		fixture(async () => {
			const file = `azure-net.config.${extension}`;
			const typed = extension === 'ts' ? ' satisfies Record<string, unknown>' : '';
			await fs.writeFile(
				file,
				`// user configuration\nconst config = { contexts: ['legacy'], sharedAlias: '$old', custom: { enabled: true }, groupRoutesFunc: (name${extension === 'ts' ? ': string' : ''}) => name.toUpperCase() }${typed};\nexport default config;\n`
			);
			await initializeConfigDefaults();
			const once = await read(file);
			await initializeConfigDefaults();
			assert.equal(await read(file), once);
			assert.ok(once.includes('// user configuration'));
			const config = await loadUserConfig();
			assert.equal(config.runChecksBeforePush, true);
			assert.deepEqual(config.contexts, ['legacy']);
			assert.equal(config.sharedAlias, '$old');
			assert.deepEqual(config.custom, { enabled: true });
			assert.equal(config.groupRoutesFunc('users'), 'USERS');
		}));
}

test('explicit false and true defaults remain byte-for-byte unchanged', () =>
	fixture(async () => {
		for (const enabled of [false, true]) {
			const content = `export default { runChecksBeforePush: ${enabled}, custom: 42 };\n`;
			await fs.writeFile('azure-net.config.ts', content);
			await initializeConfigDefaults();
			assert.equal(await read('azure-net.config.ts'), content);
		}
	}));

test('object default insertion preserves trailing comments and is idempotent', () =>
	fixture(async () => {
		await fs.writeFile('azure-net.config.js', 'export default { custom: 42 // keep this\n};');
		await initializeConfigDefaults();
		const once = await read('azure-net.config.js');
		await initializeConfigDefaults();
		assert.equal(await read('azure-net.config.js'), once);
		assert.match(once, /\/\/ keep this/);
		assert.deepEqual(await loadUserConfig(), { custom: 42, runChecksBeforePush: true });
	}));

test('invalid configuration fails without changing the source', () =>
	fixture(async () => {
		for (const content of [
			'export default { broken: ;',
			'export default [];',
			'export const value = {};',
			'export default { runChecksBeforePush: "yes" };',
			'export default { presentationWorkspaces: ["../Escape"] };'
		]) {
			await fs.writeFile('azure-net.config.ts', content);
			await assert.rejects(initializeConfigDefaults(), /Unable to load .*azure-net.config.ts/);
			assert.equal(await read('azure-net.config.ts'), content);
		}
	}));

test('fresh initialization is idempotent and ignores legacy contexts', () =>
	fixture(async () => {
		await fs.writeFile('azure-net.config.ts', "export default { contexts: ['Old'], sharedAlias: '$old' };\n");
		await fs.writeFile('svelte.config.js', 'export default { kit: { alias: { $user: "./custom" } } };');
		await initStructure();
		const once = await snapshot(process.cwd());
		await initStructure();
		assert.deepEqual(await snapshot(process.cwd()), once);
		assert.deepEqual(await discoverContexts(), ['SharedKernel']);
		await fs.access('src/app/Contexts/SharedKernel/Contracts');
		await fs.access('src/platform/Foundation');
		await fs.access('src/app/Presentation/Shared/Ui');
		assert.equal((await loadUserConfig()).runChecksBeforePush, true);
	}));

test('empty Presentation seeds config workspaces once, always adding Shared', () =>
	fixture(async () => {
		await fs.mkdir('src/app/Presentation', { recursive: true });
		await fs.writeFile('azure-net.config.ts', "export default { presentationWorkspaces: ['AdminTools'] };\n");
		await initStructure();
		assert.deepEqual(await fs.readdir('src/app/Presentation'), ['AdminTools', 'Shared']);
		await fs.writeFile('azure-net.config.ts', "export default { presentationWorkspaces: ['Later'], runChecksBeforePush: false };\n");
		await initStructure();
		assert.deepEqual(await fs.readdir('src/app/Presentation'), ['AdminTools', 'Later', 'Shared']);
		assert.equal((await loadUserConfig()).runChecksBeforePush, false);
	}));

test('existing flat Presentation is not converted by config workspaces', () =>
	fixture(async () => {
		await fs.mkdir('src/app/Presentation/Ui', { recursive: true });
		await fs.writeFile('azure-net.config.js', "export default { presentationWorkspaces: ['Admin'] };");
		await initStructure();
		assert.deepEqual(await fs.readdir('src/app/Presentation'), ['Admin', 'Shared', 'Ui']);
		prompts.inject(['Admin']);
		const workspace = await selectWorkspace();
		assert.equal(workspace.name, 'Admin');
		assert.equal(workspace.alias, '#presentation/Admin');
		prompts.inject(['__create__', 'order-details']);
		assert.equal(await selectScope(workspace), 'OrderDetails');
		await fs.access('src/app/Presentation/Admin/Scopes/OrderDetails');
	}));

test('missing config initializes defaults and context prompts create Pascal names', () =>
	fixture(async () => {
		await initializeConfigDefaults();
		assert.deepEqual(await loadUserConfig(), { appBoundaries: ['Public'], runChecksBeforePush: true });
		prompts.inject(['__create__', 'sales-orders']);
		assert.equal(await selectContext(), 'SalesOrders');
		assert.deepEqual(await discoverContexts(), ['SalesOrders', 'SharedKernel']);
		await fs.access('src/app/Contexts/SalesOrders');
	}));

const { configureAzureNetPlugin } = await import('../src/init/initEdges.ts');
for (const input of [
	'export default {plugins: [sveltekit()]};',
	"import { edgesPlugin as edges } from '@azure-net/kit/edges/plugin'; export default {plugins: [sveltekit(), edges()]};",
	"import { AzureNetPlugin as azure } from '@azure-net/kit/plugin'; export default {plugins: [sveltekit(), azure()]};",
	'export default {plugins: [sveltekit() // preserve comment\n]};'
])
	test('plugin configuration is idempotent and uses the current kit export: ' + input.slice(0, 45), () => {
		const result = configureAzureNetPlugin("import { sveltekit } from '@sveltejs/kit/vite';\n" + input);
		assert.match(result, /async: true/);
		assert.equal(configureAzureNetPlugin(result), result);
		assert.doesNotMatch(result, /kit\/edges\/plugin/);
		assert.match(result, /kit\/plugin/);
		assert.equal(ts.transpileModule(result, { reportDiagnostics: true }).diagnostics.length, 0);
	});
