import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const binary = fileURLToPath(new URL('../bin/azure-net.js', import.meta.url));
function run(...args) {
	return spawnSync(process.execPath, [binary, ...args], { encoding: 'utf8' });
}
test('published CLI exposes new commands and removes legacy command groups', () => {
	const help = run('--help');
	assert.equal(help.status, 0, help.stderr);
	for (const name of ['prettier-config', 'folders-update', 'foundation', 'bootstrap', 'git-hooks']) assert.ok(help.stdout.includes(name));
	for (const name of ['add', 'init', 'create']) {
		const result = run(name);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unknown command/);
	}
});
test('fast commands expose spec and composition controls without prompting', () => {
	for (const name of ['feature', 'feature-preset']) {
		const result = run('generate', name, '--help');
		assert.equal(result.status, 0, result.stderr);
		for (const flag of ['--spec', '--context', '--aggregate', '--auto-compose', '--no-composition', '--no-presenter'])
			assert.ok(result.stdout.includes(flag));
	}
});
