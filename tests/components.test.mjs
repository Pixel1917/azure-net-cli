import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { componentSegments, writeComponent } from '../src/generate/ui/generateComponent.js';

test('component paths are relative PascalCase paths and reject traversal', () => {
	assert.deepEqual(componentSegments('Catalog/product-card'), ['Catalog', 'ProductCard']);
	for (const input of ['../Card', '/Card', 'Catalog/../Card', 'Catalog//Card', 'Catalog\\Card', './Card'])
		assert.throws(() => componentSegments(input));
});

test('component generation creates only a local barrel and never overwrites existing code', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azure-component-'));
	try {
		const result = await writeComponent(root, 'Card');
		assert.equal(result, path.join(root, 'Card'));
		assert.deepEqual((await fs.readdir(result)).sort(), ['Component.svelte', 'Style.module.scss', 'Types.ts', 'index.ts']);
		const component = await fs.readFile(path.join(result, 'Component.svelte'), 'utf8');
		assert.match(component, /\$props\(\)/);
		assert.match(component, /import type.*\n\s*import styles/);
		await assert.rejects(writeComponent(root, 'Card'), { code: 'EEXIST' });
		assert.equal(await fs.readFile(path.join(result, 'Component.svelte'), 'utf8'), component);
		await assert.rejects(fs.access(path.join(root, 'index.ts')));
		await writeComponent(root, 'Catalog/Detail');
		await assert.rejects(fs.access(path.join(root, 'Catalog/index.ts')));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
