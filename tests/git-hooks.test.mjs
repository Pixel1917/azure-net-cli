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
import { execFileSync, spawnSync } from 'node:child_process';
const { addGitHooks, removeGitHooks } = await import('../src/git/hooks.ts');
const { loadUserConfig } = await import('../src/utils/loadConfig.ts');
const read = (file) => fs.readFile(file, 'utf8');
async function fixture(action) {
	const previous = process.cwd();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-hooks-'quoted-"));
	process.chdir(dir);
	try {
		execFileSync('git', ['init', '-q']);
		await action(dir);
	} finally {
		process.chdir(previous);
		await fs.rm(dir, { recursive: true, force: true });
	}
}
async function fakeCli(code = 0) {
	await fs.mkdir('node_modules/.bin', { recursive: true });
	await fs.writeFile('node_modules/.bin/azure-net', '#!/bin/sh\nprintf "%s" "$*" > checked\nexit ' + code + '\n', { mode: 0o755 });
}

test('hooks preserve executable originals, arguments, stdin, permissions and user config', () =>
	fixture(async () => {
		const hook = '.git/hooks/pre-commit';
		const original = '#!/bin/sh\nprintf "%s" "$*" > arguments\ncat > incoming\nexit 7\n';
		await fs.writeFile(hook, original, { mode: 0o751 });
		await fs.writeFile('azure-net.config.ts', 'export default { runChecksBeforePush: true, groupRoutesFunc: (route) => route.name };');
		await fakeCli();
		await addGitHooks();
		const once = await read(hook);
		await addGitHooks();
		assert.equal(await read(hook), once);
		assert.equal((await loadUserConfig()).runChecksBeforePush, false);
		assert.equal((await loadUserConfig()).groupRoutesFunc({ name: 'preserved' }), 'preserved');
		const result = spawnSync(path.resolve(hook), ['origin', 'url'], { input: 'refs payload\n', encoding: 'utf8' });
		assert.equal(result.status, 7, result.stderr);
		assert.equal(await read('checked'), 'check project');
		assert.equal(await read('arguments'), 'origin url');
		assert.equal(await read('incoming'), 'refs payload\n');
		await removeGitHooks();
		assert.equal(await read(hook), original);
		assert.equal((await fs.stat(hook)).mode & 0o777, 0o751);
		await removeGitHooks();
	}));

test('failed checks abort push before the original hook', () =>
	fixture(async () => {
		await fs.writeFile('.git/hooks/pre-commit', '#!/bin/sh\ntouch original-ran\n', { mode: 0o755 });
		await fakeCli(4);
		await addGitHooks();
		assert.equal(spawnSync(path.resolve('.git/hooks/pre-commit')).status, 4);
		await assert.rejects(fs.access('original-ran'), { code: 'ENOENT' });
	}));

test('custom core.hooksPath is respected and unmodified on add/remove', () =>
	fixture(async () => {
		execFileSync('git', ['config', 'core.hooksPath', '.custom hooks']);
		await fakeCli();
		await addGitHooks();
		assert.equal(spawnSync(path.resolve('.custom hooks/pre-commit')).status, 0);
		await removeGitHooks();
		assert.equal(execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim(), '.custom hooks');
		await assert.rejects(fs.access('.custom hooks/pre-commit'), { code: 'ENOENT' });
	}));

test('modified hooks and orphan backups are never clobbered', () =>
	fixture(async () => {
		await addGitHooks();
		await fs.appendFile('.git/hooks/pre-commit', '# custom\n');
		const custom = await read('.git/hooks/pre-commit');
		await assert.rejects(removeGitHooks(), /modified/);
		await assert.rejects(addGitHooks(), /modified/);
		assert.equal(await read('.git/hooks/pre-commit'), custom);
		await fs.rm('.git/hooks/pre-commit.azure-net.json');
		await fs.writeFile('.git/hooks/pre-commit.azure-net-original', 'keep');
		await assert.rejects(addGitHooks(), /backup preserved/);
		assert.equal(await read('.git/hooks/pre-commit.azure-net-original'), 'keep');
	}));

test('nonexecutable hook remains nonexecutable after removal and is not run', () =>
	fixture(async () => {
		await fs.writeFile('.git/hooks/pre-commit', '#!/bin/sh\nexit 9\n', { mode: 0o644 });
		await fakeCli();
		await addGitHooks();
		assert.equal(spawnSync(path.resolve('.git/hooks/pre-commit')).status, 0);
		await removeGitHooks();
		assert.equal((await fs.stat('.git/hooks/pre-commit')).mode & 0o777, 0o644);
	}));

test('invalid config prevents hook changes', () =>
	fixture(async () => {
		const original = '#!/bin/sh\nexit 0\n';
		await fs.writeFile('.git/hooks/pre-commit', original, { mode: 0o755 });
		await fs.writeFile('azure-net.config.ts', 'export default { runChecksBeforePush: "not boolean" };');
		await assert.rejects(addGitHooks(), /Unable to load/);
		assert.equal(await read('.git/hooks/pre-commit'), original);
		await assert.rejects(fs.access('.git/hooks/pre-commit.azure-net-original'), { code: 'ENOENT' });
	}));

test('fresh accepting hooks disables CLI push checks and detects package manager', () =>
	fixture(async () => {
		await fs.writeFile('package.json', JSON.stringify({ type: 'module', packageManager: 'pnpm@9.0.0' }));
		await fs.writeFile('vite.config.ts', "import { sveltekit } from '@sveltejs/kit/vite'; export default {plugins: [sveltekit()]};");
		const { default: installFresh } = await import('../src/install/installFresh.ts');
		prompts._injected = [];
		prompts.inject([false, false, false, false, false, false, false, true]);
		await installFresh();
		assert.equal((await loadUserConfig()).runChecksBeforePush, false);
		assert.equal((await loadUserConfig()).packageManager, 'pnpm');
		assert.match(await read('.git/hooks/pre-commit'), /azure-net check project/);
		await assert.rejects(fs.access('.git/hooks/pre-push'), { code: 'ENOENT' });
		await assert.rejects(fs.access('node_modules'), { code: 'ENOENT' });
	}));
