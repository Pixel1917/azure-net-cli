import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planMigration, applyMigration } from '../src/migrate/migrate.js';
import { migrateConfig } from '../src/migrate/config.js';
import { migrateCurrentApis } from '../src/migrate/currentApis.js';

async function fixture(input, run) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-current-'));
	const put = async (file, text) => {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), text);
	};
	try {
		await put('azure-net.config.ts', 'export default {};');
		await put('tsconfig.json', '{}');
		await fs.mkdir(path.join(root, 'src'), { recursive: true });
		for (const [file, content] of Object.entries(input)) await put(file, content);
		await run(root, put);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
const oldPlatform = { 'src/app/Platform/Foundation/Provider/HttpProvider.ts': 'export const HttpProvider = () => ({});' };

test('relocates platform, migrates known conditional aliases, and plans without writes', () =>
	fixture(
		{
			...oldPlatform,
			'package.json': JSON.stringify({
				imports: { '#platform/*': { types: ['./src/app/Platform/*.ts', './src/app/Platform/*/index.ts'], default: './src/app/Platform/*' } }
			}),
			'src/routes/+page.ts': "import {HttpProvider} from '#platform/Foundation/Provider/HttpProvider'; export const load = HttpProvider;"
		},
		async (root) => {
			const plan = await planMigration(root);
			assert.equal(await fs.readFile(path.join(root, Object.keys(oldPlatform)[0]), 'utf8'), Object.values(oldPlatform)[0]);
			await assert.rejects(fs.access(path.join(root, 'src/platform')), /ENOENT/);
			await assert.rejects(fs.access(path.join(root, '.azure-net')), /ENOENT/);
			const pkg = JSON.parse(plan.writes.get(path.join(root, 'package.json')));
			assert.equal(pkg.imports['#platform/*'].default, './src/platform/*');
			assert.deepEqual(pkg.imports['#platform/*'].types, ['./src/platform/*.ts', './src/platform/*/index.ts']);
			assert(!('#platform' in pkg.imports));
			await applyMigration(plan);
			await fs.access(path.join(root, 'src/platform/Foundation/Provider/HttpProvider.ts'));
			await assert.rejects(fs.access(path.join(root, Object.keys(oldPlatform)[0])), /ENOENT/);
			await assert.rejects(planMigration(root), /Nothing to migrate/);
		}
	));

test('custom platform mappings are retained and new references use relative paths', () =>
	fixture(
		{
			...oldPlatform,
			'package.json': JSON.stringify({ imports: { '#platform/*': './custom-platform/*', '#platform': './my-entry.ts' } }),
			'src/routes/+page.ts':
				"import {HttpProvider} from '../app/Platform/Foundation/Provider/HttpProvider'; export const load = HttpProvider;"
		},
		async (root) => {
			const plan = await planMigration(root);
			const pkg = JSON.parse(plan.writes.get(path.join(root, 'package.json')));
			assert.equal(pkg.imports['#platform/*'], './custom-platform/*');
			assert.equal(pkg.imports['#platform'], './my-entry.ts');
			assert.match(
				plan.writes.get(path.join(root, 'src/routes/+page.ts')).toString(),
				/\.\.\/platform\/Foundation\/Provider\/HttpProvider/
			);
			assert(plan.issues.some((i) => /Custom package import/.test(i.reason)));
		}
	));

test('SvelteKit virtual $types imports are preserved without false unresolved warnings', () =>
	fixture(
		{
			...oldPlatform,
			'src/routes/+page.ts': "import type { PageLoad } from './$types'; export const load: PageLoad = () => ({});",
			'src/routes/+page.svelte': `<script lang="ts">import type { PageData } from './$types.js'; let data: PageData;</script><p>Keep markup</p>`,
			'src/routes/+layout.ts': "import type { Missing } from './actually-missing';"
		},
		async (root) => {
			const plan = await planMigration(root);
			assert(!plan.issues.some((i) => i.reason.includes('$types')));
			assert(plan.issues.some((i) => i.reason.includes('actually-missing')));
			assert(!plan.writes.has(path.join(root, 'src/routes/+page.ts')));
			assert(!plan.writes.has(path.join(root, 'src/routes/+page.svelte')));
		}
	));

test('appBoundaries wins; legacy fallback and custom config expressions retain behavior', () => {
	const canonical = "export default {appBoundaries:['Admin'],presentationWorkspaces:['Public']};";
	assert.equal(migrateConfig(canonical, ['Shared']).content, canonical);
	assert.match(
		migrateConfig("export default {'presentationWorkspaces': getBoundaries()};", []).content,
		/appBoundaries: getBoundaries\(\)/
	);
	for (const input of [
		'export default getConfig();',
		'export default {...custom};',
		'export default {get presentationWorkspaces(){return list;}};'
	]) {
		const result = migrateConfig(input, ['Shared']);
		assert.equal(result.content, input);
		assert.equal(result.issues.length, 1);
	}
});

test('prior flat contexts retain original files and repeated backups never overwrite bytes', () =>
	fixture(
		{
			'src/app/Contexts/Orders/Domain/Entities/Order.ts': 'export interface Order { id: string }'
		},
		async (root, put) => {
			const original = 'src/app/Contexts/Orders/Domain/Entities/Order.ts';
			const archive = 'src/app/.backup/Contexts/Orders/Domain/Entities/Order.ts';
			const first = await planMigration(root);
			assert.equal(first.moves.length, 0);
			assert(first.issues.some((i) => /aggregate and context/.test(i.reason)));
			await applyMigration(first);
			assert.equal(await fs.readFile(path.join(root, original), 'utf8'), await fs.readFile(path.join(root, archive), 'utf8'));
			await applyMigration(await planMigration(root));
			await put(original, 'export interface Order { id: number }');
			const third = await planMigration(root);
			assert([...third.writes.keys()].some((file) => file.startsWith(path.join(root, archive) + '.')));
			await applyMigration(third);
			assert.match(await fs.readFile(path.join(root, archive), 'utf8'), /id: string/);
			assert.match(await fs.readFile(path.join(root, original), 'utf8'), /id: number/);
		}
	));

test('existing platform destination is never overwritten or silently merged', () =>
	fixture(
		{
			...oldPlatform,
			'src/platform/Foundation/Provider/HttpProvider.ts': '// existing implementation'
		},
		async (root) => {
			const plan = await planMigration(root);
			assert(plan.issues.some((i) => /Target collision/.test(i.reason)));
			assert.equal(plan.moves.length, 0);
			await applyMigration(plan);
			assert.equal(
				await fs.readFile(path.join(root, 'src/platform/Foundation/Provider/HttpProvider.ts'), 'utf8'),
				'// existing implementation'
			);
			await fs.access(path.join(root, Object.keys(oldPlatform)[0]));
		}
	));

test('apply refuses symlink replacement of a target parent before writing anything', () =>
	fixture(oldPlatform, async (root) => {
		const plan = await planMigration(root);
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-outside-'));
		try {
			await fs.symlink(outside, path.join(root, 'src/platform'));
			await assert.rejects(applyMigration(plan), /symbolic link/);
			assert.deepEqual(await fs.readdir(outside), []);
			await fs.access(path.join(root, Object.keys(oldPlatform)[0]));
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	}));

test('RegisterProvider options migration respects imported aliases and lexical shadows', () => {
	const source = `import {RegisterProvider as register} from '@azure-net/kit/delivery';
export const provider = register(() => ({}), 'scoped');
function other(register) { return register(() => ({}), 'scoped'); }`;
	const result = migrateCurrentApis(source, 'Source.ts');
	assert.match(result.content, /\{ lifecycle: "scoped" \}/);
	assert.match(result.content, /return register\(\(\) => \(\{\}\), 'scoped'\)/);
	assert.equal(migrateCurrentApis(result.content, 'Source.ts').content, result.content);
});

test('explicit HTTP-backed application provider becomes a context root without flattening register', () =>
	fixture(
		{
			'src/app/sales/layers/application/providers/ApplicationProvider.ts': `import {CreateServiceContainer} from '@azure-net/kit';
import {HttpProvider} from '#platform/Foundation/Provider/HttpProvider';
export const SalesProvider = CreateServiceContainer('Sales', {dependsOn:{HttpProvider},register:({HttpProvider})=>({Orders:()=>HttpProvider.orders})});`,
			'src/platform/Foundation/Provider/HttpProvider.ts': 'export const HttpProvider = () => ({orders: {}});',
			'src/routes/+page.ts':
				"import {SalesProvider} from '../app/sales/layers/application/providers/ApplicationProvider'; export const load = () => SalesProvider().Orders;"
		},
		async (root) => {
			const plan = await planMigration(root);
			const output = plan.writes.get(path.join(root, 'src/app/Contexts/Sales/Composition.ts')).toString();
			assert.match(output, /new MigratedCompositionRoot/);
			assert.match(output, /dependsOn:\{HttpProvider\}/);
			assert.match(output, /SalesProvider = SalesContext.resolve/);
			assert.match(plan.writes.get(path.join(root, 'src/routes/+page.ts')).toString(), /#contexts\/Sales\/Composition/);
			await applyMigration(plan);
			await assert.rejects(planMigration(root), /Nothing to migrate/);
		}
	));
