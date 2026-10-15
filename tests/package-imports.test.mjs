import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import initAliases from '../src/init/initAliases.js';
import { mergePackageImports, resolvePackageImport } from '../src/utils/packageImports.js';

test('initialization writes imports only, preserves Vite byte-for-byte and is idempotent', async () => {
	const cwd = process.cwd(),
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-subpath-'));
	process.chdir(root);
	try {
		await fs.writeFile('package.json', JSON.stringify({ name: 'test', imports: { '#custom/*': './custom/*' } }));
		const vite = '// user config\nexport default {}';
		await fs.writeFile('vite.config.ts', vite);
		await initAliases();
		const first = await fs.readFile('package.json', 'utf8');
		await initAliases();
		assert.equal(await fs.readFile('package.json', 'utf8'), first);
		assert.equal(await fs.readFile('vite.config.ts', 'utf8'), vite);
		const { imports } = JSON.parse(first);
		assert.equal(imports['#custom/*'], './custom/*');
		await fs.mkdir('src/app/Contexts/Orders', { recursive: true });
		await fs.writeFile('src/app/Contexts/Orders/index.ts', 'export const value=42');
		await fs.writeFile('src/app/Contexts/Orders/Order.ts', 'export interface IOrder {}');
		for (const name of ['#contexts/Orders', '#contexts/Orders/Order'])
			assert(
				ts.resolveModuleName(
					name,
					path.join(root, 'src/test.ts'),
					{ moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext },
					ts.sys
				).resolvedModule,
				name
			);
		assert.equal(resolvePackageImport(imports, '#contexts/Orders', root), path.join(root, 'src/app/Contexts/Orders'));
	} finally {
		process.chdir(cwd);
		await fs.rm(root, { recursive: true, force: true });
	}
});
test('conflicting reserved package imports are not silently overwritten', async () => {
	await assert.rejects(mergePackageImports(JSON.stringify({ imports: { '#contexts/*': './other/*' } })), /Conflicting/);
});
