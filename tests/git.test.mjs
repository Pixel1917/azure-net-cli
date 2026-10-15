import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import ts from 'typescript';

// Isolated TS transpilation: no global build or generated files in the working tree.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-net-git-tests-'));
after(() => fs.rmSync(output, { recursive: true, force: true }));
fs.writeFileSync(path.join(output, 'package.json'), '{"type":"module"}');
fs.symlinkSync(path.join(root, 'node_modules'), path.join(output, 'node_modules'), 'dir');
function compile(dir) {
	for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const relative = path.join(dir, entry.name);
		if (entry.isDirectory()) compile(relative);
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			const target = path.join(output, relative.replace(/\.ts$/, '.js'));
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(
				target,
				ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
					compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
				}).outputText
			);
		}
	}
}
compile('src');
const load = (file) => import(pathToFileURL(path.join(output, file)).href);
const { default: commit, validateSubject, formatCommitMessage, CommitCancelledError } = await load('src/git/commit.js');
const { default: push } = await load('src/git/push.js');
const { runGit } = await load('src/git/runGit.js');
const { default: addLint } = await load('src/plugins/addLint.js');
const answers = { type: 'feat', subject: 'support git commands' };
const prompt = async () => answers;

test('subject validation and conventional message formatting', () => {
	for (const value of ['', '   ', 'a'.repeat(101), 'line\nbreak', 'null\0']) assert.notEqual(validateSubject(value), true);
	assert.equal(validateSubject('a'.repeat(100)), true);
	assert.equal(formatCommitMessage(answers), 'feat(\u2728): support git commands');
	assert.equal(
		formatCommitMessage({ ...answers, body: 'Details', breaking: 'New API', footer: 'Closes #3' }),
		'feat(\u2728)!: support git commands\n\nDetails\n\nBREAKING CHANGE: New API\n\nCloses #3'
	);
	assert.throws(() => formatCommitMessage({ ...answers, type: 'invalid' }));
	assert.throws(() => formatCommitMessage({ ...answers, body: '\0' }));
});

test('standalone commit never stages; shell metacharacters remain one argument', async () => {
	const calls = [];
	const subject = 'quotes " $(touch hacked); `echo nope`';
	await commit({
		prompt: async () => ({ ...answers, subject }),
		git: async (args) => {
			calls.push(args);
		}
	});
	assert.deepEqual(calls, [['commit', '-m', `feat(\u2728): ${subject}`]]);
});

test('cancellation at any prompt stops commit even with partial answers', async () => {
	for (let index = 0; index < 5; index++) {
		await assert.rejects(
			commit({
				prompt: async (questions, options) => {
					assert.equal(questions.length, 5);
					options.onCancel(questions[index]);
					return answers;
				},
				git: async () => assert.fail('must not commit')
			}),
			CommitCancelledError
		);
	}
});

test('push checks by default then stages, prompts, commits and pushes in order', async () => {
	const calls = [];
	await push(
		{},
		{
			loadConfig: async () => ({}),
			checkProject: async () => {
				calls.push('checks');
			},
			prompt: async () => {
				calls.push('prompt');
				return answers;
			},
			git: async (args) => {
				calls.push(args);
			}
		}
	);
	assert.deepEqual(calls, ['checks', ['add', '.'], 'prompt', ['commit', '-m', 'feat(\u2728): support git commands'], ['push']]);
});

test('push skips checks only for explicit false config or --no-check', async () => {
	for (const [options, config, expected] of [
		[{}, false, false],
		[{ check: false }, true, false],
		[{}, 'false', true],
		[{}, true, true]
	]) {
		let checked = false;
		await push(options, {
			loadConfig: async () => ({ runChecksBeforePush: config }),
			checkProject: async () => {
				checked = true;
			},
			prompt,
			git: async () => {}
		});
		assert.equal(checked, expected);
	}
});

test('check exception and exitCode both stop before staging', async () => {
	const previous = process.exitCode;
	try {
		for (const throws of [true, false]) {
			process.exitCode = 0;
			await assert.rejects(
				push(
					{},
					{
						loadConfig: async () => ({}),
						checkProject: async () => {
							if (throws) throw new Error('failed');
							process.exitCode = 1;
						},
						git: async () => assert.fail('must not stage')
					}
				)
			);
		}
	} finally {
		process.exitCode = previous;
	}
});

test('git failures stop the push chain at each step', async () => {
	for (const failed of ['add', 'commit', 'push']) {
		const calls = [];
		await assert.rejects(
			push(
				{ check: false },
				{
					prompt,
					git: async (args) => {
						calls.push(args[0]);
						if (args[0] === failed) throw new Error('failed');
					}
				}
			)
		);
		assert.deepEqual(calls, ['add', 'commit', 'push'].slice(0, ['add', 'commit', 'push'].indexOf(failed) + 1));
	}
});

test('push cancellation leaves staging alone and never commits or pushes', async () => {
	const calls = [];
	await assert.rejects(
		push(
			{ check: false },
			{
				prompt: async (_, options) => {
					options.onCancel();
					return answers;
				},
				git: async (args) => {
					calls.push(args);
				}
			}
		),
		CommitCancelledError
	);
	assert.deepEqual(calls, [['add', '.']]);
});

test('spawn uses args without a shell and rejects nonzero, signals and spawn errors', async () => {
	const original = childProcess.spawn;
	try {
		for (const outcome of ['success', 'nonzero', 'signal', 'error']) {
			childProcess.spawn = (command, args, options) => {
				assert.equal(command, 'git');
				assert.deepEqual(args, ['commit', '-m', 'fix: " $(echo nope)']);
				assert.deepEqual(options, { stdio: 'inherit', shell: false });
				const child = new EventEmitter();
				queueMicrotask(() => {
					if (outcome === 'error') child.emit('error', new Error('ENOENT'));
					else child.emit('close', outcome === 'success' ? 0 : outcome === 'signal' ? null : 1, outcome === 'signal' ? 'SIGINT' : null);
				});
				return child;
			};
			syncBuiltinESMExports();
			const result = runGit(['commit', '-m', 'fix: " $(echo nope)']);
			if (outcome === 'success') await result;
			else await assert.rejects(result);
		}
	} finally {
		childProcess.spawn = original;
		syncBuiltinESMExports();
	}
});

test('patch and release include their emojis', () => {
	assert.equal(formatCommitMessage({ ...answers, type: 'patch' }), 'patch(\ud83d\udd27): support git commands');
	assert.equal(formatCommitMessage({ ...answers, type: 'release' }), 'release(\ud83d\ude80): support git commands');
});

test('commit-tools replaces configs, backs up originals uniquely, and installs nothing', async () => {
	const cwd = process.cwd();
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-net-commit-tools-'));
	const originalSpawn = childProcess.spawn;
	const originalExec = childProcess.execSync;
	const originalNow = Date.now;
	try {
		childProcess.spawn = childProcess.execSync = () => assert.fail('must not execute installers or scripts');
		syncBuiltinESMExports();
		Date.now = () => 12345;
		process.chdir(temp);
		const pkg = '{"scripts":{"prepare":"custom"},"dependencies":{"existing":"1"}}';
		fs.writeFileSync('package.json', pkg);
		fs.writeFileSync('azure-net.config.ts', 'export default { packageManager: "bun" };');
		fs.mkdirSync('.husky');
		fs.writeFileSync('.husky/pre-commit', 'custom hook');
		await addLint();
		assert.deepEqual(fs.readdirSync('.').sort(), ['.husky', '.prettierrc', 'azure-net.config.ts', 'package.json']);
		const expected = fs.readFileSync('.prettierrc', 'utf8');
		assert.equal(JSON.parse(expected).plugins, undefined);
		const backupRoot = path.join('.azure-net', 'PrettierBackups');
		const seen = new Set();
		for (let i = 0; i < 8; i++) {
			const previous = `custom config ${i}`;
			fs.writeFileSync('.prettierrc', previous);
			await addLint();
			const dirs = fs.readdirSync(backupRoot);
			assert.equal(dirs.length, i + 1);
			const fresh = dirs.filter((name) => !seen.has(name));
			assert.equal(fresh.length, 1);
			seen.add(fresh[0]);
			assert.equal(fs.readFileSync(path.join(backupRoot, fresh[0], '.prettierrc'), 'utf8'), previous);
			assert.equal(fs.readFileSync('.prettierrc', 'utf8'), expected);
		}
		fs.writeFileSync('prettier.config.mjs', 'export default { semi: false };');
		const pkgWithPrettier = JSON.stringify({ ...JSON.parse(pkg), prettier: { semi: false } });
		fs.writeFileSync('package.json', pkgWithPrettier);
		await addLint();
		const fresh = fs.readdirSync(backupRoot).filter((name) => !seen.has(name));
		assert.equal(fresh.length, 1);
		const backup = path.join(backupRoot, fresh[0]);
		assert.equal(fs.readFileSync(path.join(backup, 'package.json'), 'utf8'), pkgWithPrettier);
		assert.equal(fs.readFileSync(path.join(backup, 'prettier.config.mjs'), 'utf8'), 'export default { semi: false };');
		assert.equal(fs.readFileSync(path.join(backup, '.prettierrc'), 'utf8'), expected);
		assert.equal(fs.existsSync('prettier.config.mjs'), false);
		assert.deepEqual(JSON.parse(fs.readFileSync('package.json', 'utf8')), JSON.parse(pkg));
		assert.equal(fs.readFileSync('azure-net.config.ts', 'utf8'), 'export default { packageManager: "bun" };');
		assert.equal(fs.readFileSync('.husky/pre-commit', 'utf8'), 'custom hook');
	} finally {
		Date.now = originalNow;
		childProcess.spawn = originalSpawn;
		childProcess.execSync = originalExec;
		syncBuiltinESMExports();
		process.chdir(cwd);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('commit-tools fails without package.json without creating anything', async () => {
	const cwd = process.cwd();
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-net-missing-package-'));
	try {
		process.chdir(temp);
		await assert.rejects(addLint(), /package.json not found/);
		assert.deepEqual(fs.readdirSync('.'), []);
	} finally {
		process.chdir(cwd);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('real git in tmp: staged-only commit, literal message, local push and cancellation', async () => {
	const cwd = process.cwd();
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-net-real-git-'));
	const previousEnv = { ...process.env };
	try {
		// Ignore inherited repository pointers, global hooks, signing, identity and remotes.
		for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.GIT_CONFIG_GLOBAL = path.join(temp, 'empty-config');
		process.env.GIT_ALLOW_PROTOCOL = 'file';
		fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
		process.chdir(temp);
		const git = (...args) => childProcess.execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		git('init', '--bare', '--template=', 'remote.git');
		git('init', '--template=', '-b', 'main', 'work');
		process.chdir(path.join(temp, 'work'));
		git('config', 'user.name', 'CLI Test');
		git('config', 'user.email', 'cli@example.invalid');
		git('config', 'commit.gpgsign', 'false');
		git('config', 'core.hooksPath', path.join(temp, 'no-hooks'));
		fs.writeFileSync('staged.txt', 'staged version');
		git('add', 'staged.txt');
		fs.writeFileSync('staged.txt', 'unstaged version');
		fs.writeFileSync('untracked.txt', 'must not enter standalone commit');
		const subject = 'literal " $(touch hacked) `touch hacked2`; --amend';
		await commit({ prompt: async () => ({ ...answers, subject, body: 'Details', breaking: 'API', footer: 'Closes #7' }) });
		assert.equal(git('show', 'HEAD:staged.txt'), 'staged version');
		assert.equal(git('ls-tree', '--name-only', 'HEAD'), 'staged.txt');
		assert.equal(git('log', '-1', '--format=%B'), `feat(\u2728)!: ${subject}\n\nDetails\n\nBREAKING CHANGE: API\n\nCloses #7`);
		assert.equal(fs.existsSync('hacked'), false);
		assert.equal(fs.existsSync('hacked2'), false);
		await assert.rejects(commit({ prompt }));
		assert.equal(git('rev-list', '--count', 'HEAD'), '1');
		git('remote', 'add', 'origin', path.join(temp, 'remote.git'));
		git('config', 'branch.main.remote', 'origin');
		git('config', 'branch.main.merge', 'refs/heads/main');
		let checked = false;
		await push(
			{},
			{
				loadConfig: async () => ({}),
				checkProject: async () => {
					checked = true;
					fs.writeFileSync('formatted.txt', 'from checks');
				},
				prompt
			}
		);
		assert.equal(checked, true);
		assert.equal(git('status', '--porcelain'), '');
		assert.equal(git('--git-dir', path.join(temp, 'remote.git'), 'rev-parse', 'refs/heads/main'), git('rev-parse', 'HEAD'));
		assert.equal(git('show', 'HEAD:formatted.txt'), 'from checks');
		const head = git('rev-parse', 'HEAD');
		fs.writeFileSync('cancelled.txt', 'pending');
		await assert.rejects(
			push(
				{ check: false },
				{
					prompt: async (_, options) => {
						options.onCancel();
						return answers;
					}
				}
			),
			CommitCancelledError
		);
		assert.equal(git('rev-parse', 'HEAD'), head);
		assert.equal(git('--git-dir', path.join(temp, 'remote.git'), 'rev-parse', 'refs/heads/main'), head);
		assert.equal(git('diff', '--cached', '--name-only'), 'cancelled.txt');
	} finally {
		process.chdir(cwd);
		for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
		Object.assign(process.env, previousEnv);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});
