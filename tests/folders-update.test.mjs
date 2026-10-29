import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import update from '../src/init/initStructure.js';

test('folders-update creates only SharedKernel, adds configured boundaries repeatedly and preserves files', async () => {
	const cwd = process.cwd();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azure-folders-'));
	process.chdir(root);
	try {
		await fs.writeFile('package.json', '{}');
		await fs.writeFile('azure-net.config.ts', "export default {appBoundaries:['Public']}");
		await update();
		assert.deepEqual((await fs.readdir('src/app')).sort(), ['Contexts', 'Presentation']);
		assert.deepEqual(await fs.readdir('src/app/Contexts'), ['SharedKernel']);
		assert.deepEqual((await fs.readdir('src/app/Contexts/SharedKernel')).sort(), ['Contracts', 'Domain']);
		assert.deepEqual((await fs.readdir('src/platform')).sort(), ['Bootstrap', 'Foundation']);
		assert.deepEqual((await fs.readdir('src/app/Presentation/Public/Ui/Components')).sort(), ['Composite', 'Core', 'Page', 'Scopes']);
		assert.deepEqual(await fs.readdir('src/app/Presentation/Public/Scopes'), []);
		await fs.writeFile('src/app/Presentation/Public/Shell/Header.ts', '// keep me');
		await fs.writeFile('azure-net.config.ts', "export default {appBoundaries:['Public','Admin'],runChecksBeforePush:false}");
		await update();
		assert.deepEqual((await fs.readdir('src/app/Presentation')).sort(), ['Admin', 'Public', 'Shared']);
		assert.equal(await fs.readFile('src/app/Presentation/Public/Shell/Header.ts', 'utf8'), '// keep me');
		assert.deepEqual(await fs.readdir('src/platform/Foundation'), []);
		const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
		assert.equal(pkg.imports['#platform/*'].default, './src/platform/*');
		assert.equal(pkg.imports['#platform'], undefined);
	} finally {
		process.chdir(cwd);
		await fs.rm(root, { recursive: true, force: true });
	}
});
