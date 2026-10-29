import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import prompts from 'prompts';
import generate from '../src/generate/routes/generateRoutes.js';
test('routes use sibling platform and overwrite only the generated route list', async () => {
	const cwd = process.cwd();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-routes-platform-'));
	process.chdir(root);
	try {
		await fs.mkdir('src/routes/(public)/products/[id]', { recursive: true });
		await fs.writeFile('src/routes/(public)/products/[id]/+page.svelte', '<p>Product</p>');
		prompts.inject(['none']);
		await generate();
		const target = 'src/platform/Bootstrap/Routes/index.ts';
		assert.match(await fs.readFile(target, 'utf8'), /\/products\/\{id\}/);
		await fs.writeFile(target, '// obsolete generated data');
		prompts.inject(['none']);
		await generate();
		assert.doesNotMatch(await fs.readFile(target, 'utf8'), /obsolete/);
		await assert.rejects(fs.access('src/app/Platform'));
	} finally {
		process.chdir(cwd);
		await fs.rm(root, { recursive: true, force: true });
	}
});
