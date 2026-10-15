import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import boundaries from '../src/checks/checkLayerBoundaries.js';
import layers from '../src/checks/checkLayerImports.js';
import folders from '../src/checks/checkFoldersStructure.js';
import domain from '../src/checks/checkDomain.js';
import imports from '../src/checks/checkImports.js';
import internal from '../src/checks/checkInternal.js';
import providerNames from '../src/checks/checkProviderNames.js';
import providerGraph from '../src/checks/checkProviderGraph.js';
import hooks from '../src/checks/checkHooks.js';
import { dependencies } from '../src/checks/architecture.js';

async function fixture(run) {
	const cwd = process.cwd();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checks-'));
	const write = async (file, content = '') => {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), content);
	};
	try {
		process.chdir(root);
		await write('package.json', '{"type":"module"}');
		for (const context of ['Orders', 'Billing', 'SharedKernel'])
			for (const folder of ['Domain/Entities', 'Domain/Ports', 'Domain/Enums', 'Application/UseCases', 'Infrastructure/Repositories'])
				await fs.mkdir(path.join(root, 'src/app/Contexts', context, folder), { recursive: true });
		for (const folder of ['Presentation', 'Platform']) await fs.mkdir(path.join(root, 'src/app', folder), { recursive: true });
		await run(write);
	} finally {
		process.chdir(cwd);
		process.exitCode = 0;
		await fs.rm(root, { recursive: true, force: true });
	}
}
async function check(fn, fails = false) {
	const log = console.log;
	const error = console.error;
	const messages = [];
	console.log = console.error = (...args) => messages.push(args.join(' '));
	process.exitCode = 0;
	try {
		await fn();
		assert.equal(process.exitCode, fails ? 1 : 0, messages.join('\n'));
		return messages.join('\n');
	} finally {
		console.log = log;
		console.error = error;
		process.exitCode = 0;
	}
}

test('extracts static, side-effect, reexports and dynamic imports, ignores comments and strings', () => {
	assert.deepEqual(
		dependencies(
			`// import 'fake';\nconst s="import 'fake'"; import X from 'a'; export * from 'b'; export * as N from 'c'; import('d'); import('e', {with:{type:'json'}}); import 'f'; import type {T} from 'g';`
		).map((x) => x.source),
		['a', 'b', 'c', 'd', 'e', 'f', 'g']
	);
});

for (const statement of [
	"import X from '#contexts/Billing/Domain/Entities/X'",
	"export * from '#contexts/Billing/Domain/Entities/X'",
	"export {X} from '#contexts/Billing/Domain/Entities/X'",
	"import('#contexts/Billing/Domain/Entities/X')",
	"import '../../Billing/Domain/Entities/X'",
	"import('#contexts/Billing/Domain/Entities/X', {with:{type:'json'}})"
]) {
	test(`rejects cross-context ${statement}`, () =>
		fixture(async (write) => {
			await write('src/app/Contexts/Orders/Domain/Test.ts', statement);
			await check(boundaries, true);
		}));
}
test('SharedKernel is one-way, context isolation includes Presentation', () =>
	fixture(async (write) => {
		await write('src/app/Contexts/Orders/Domain/Test.ts', "import '#contexts/SharedKernel/Domain/Entities/X'");
		await check(boundaries);
		await write('src/app/Contexts/SharedKernel/Domain/Test.ts', "import '#contexts/Orders/Domain/Entities/X'");
		await check(boundaries, true);
		await write('src/app/Contexts/SharedKernel/Domain/Test.ts', "import '#presentation/Ui/X'");
		await check(boundaries, true);
		await check(layers, true);
	}));
test('layer direction retains Application to Infrastructure', () =>
	fixture(async (write) => {
		await write('src/app/Contexts/Orders/Application/Test.ts', "import '#contexts/Orders/Infrastructure/Repositories/X'");
		await check(layers);
		await write('src/app/Contexts/Orders/Domain/Test.ts', "export * from '../Infrastructure/Repositories/X'");
		await check(layers, true);
		await write('src/app/Contexts/Orders/Domain/Test.ts', '');
		await write('src/app/Contexts/Orders/Infrastructure/Test.ts', "import('../Application/UseCases/X')");
		await check(layers, true);
	}));
test('real Svelte aliases including wildcard and absolute targets', () =>
	fixture(async (write) => {
		await write(
			'svelte.config.js',
			`export default {kit:{alias:{'@billing/*':'./src/app/Contexts/Billing/*', '@ui':${JSON.stringify(path.join(process.cwd(), 'src/app/Presentation'))}}}};`
		);
		await write('src/app/Contexts/Orders/Domain/Test.ts', "import '@billing/Domain/X'");
		await check(boundaries, true);
		await write('src/app/Contexts/Orders/Domain/Test.ts', "import '@ui/Ui/X'");
		await check(boundaries, true);
	}));
test('workspace isolation and Shared direction; routes and Platform compose contexts', () =>
	fixture(async (write) => {
		await write('src/app/Presentation/Admin/Ui/Test.ts', "import '#presentation/Shared/Ui/X'");
		await write('src/app/Presentation/routes/Test.ts', "import '#contexts/Orders/Domain/X'; import '#contexts/Billing/Domain/X'");
		await write('src/app/Platform/Foundation/DI/Test.ts', "import '#contexts/Orders/Domain/X'; import '#contexts/Billing/Domain/X'");
		await check(boundaries);
		await write('src/app/Presentation/Admin/Ui/Test.ts', "import '#presentation/Shop/Ui/X'");
		await check(boundaries, true);
		await write('src/app/Presentation/Admin/Ui/Test.ts', '');
		await write('src/app/Presentation/Shared/Ui/Test.ts', "export * from '../../Admin/Ui/X'");
		await check(boundaries, true);
	}));
test('folder shape, naming, barrels and routes outside app', () =>
	fixture(async (write) => {
		await write('src/routes/+page.svelte', '<h1>Hello</h1>');
		await write('src/app/Presentation/Ui/Card.svelte', '');
		await write('src/app/Platform/index.ts', "export * as DI from './Foundation/DI';");
		await check(folders);
		await write('src/app/Platform/badName.ts', '');
		await check(folders, true);
		await fs.rm('src/app/Platform/badName.ts');
		await write('src/app/Platform/index.ts', 'export const Bad = 1;');
		await check(folders);
		await write('src/app/Platform/index.ts', '');
		await fs.mkdir('src/app/Contexts/Orders/Domain/Wrong');
		await check(folders, true);
	}));
test('domain names, generic aliases, declaration limits and enum exemption', () =>
	fixture(async (write) => {
		await write('src/app/Contexts/Orders/Domain/Entities/Order.ts', 'export interface IOrder {}\nexport type TOrder<T> = T;');
		await check(domain);
		await write('src/app/Contexts/Orders/Domain/Enums/State.ts', 'export enum State { Active }');
		await check(domain);
		await write('src/app/Contexts/Orders/Domain/Ports/IPort.ts', 'export interface Bad {}');
		await check(domain, true);
		await fs.rm('src/app/Contexts/Orders/Domain/Ports/IPort.ts');
		await write(
			'src/app/Contexts/Orders/Domain/Entities/Order.ts',
			Array.from({ length: 6 }, (_, i) => `export type TItem${i}<T> = T;`).join('\n')
		);
		await check(domain, true);
	}));
test('import styles include dynamic imports and reexports', () =>
	fixture(async (write) => {
		await write('src/app/Platform/Test.ts', "import('./Other.ts'); export * from './Other.js';");
		await check(imports, true);
		await write('src/app/Platform/Test.ts', "import type {T} from './Other'; import {X} from './Other'");
		await check(imports, true);
	}));
test('provider and hooks regressions and internal runs every check after failure', () =>
	fixture(async (write) => {
		await check(internal);
		await write(
			'src/app/Platform/Test.ts',
			"CreateDiContainer('A', {dependsOn:{B:true}}); CreateDiContainer('B', {dependsOn:{A:true}}); CreateDiContainer('A', {});"
		);
		await write('src/hooks.server.ts', '');
		await check(providerNames, true);
		await check(providerGraph, true);
		await check(hooks, true);
		const output = await check(internal, true);
		for (const name of ['provider-graph', 'domain', 'imports', 'hooks', 'layer-imports', 'layer-boundaries', 'folders-structure'])
			assert.ok(output.includes(`Running check ${name}`));
	}));

test('Enums retains interface/type naming and five-declaration limit', () =>
	fixture(async (write) => {
		const file = 'src/app/Contexts/Orders/Domain/Enums/State.ts';
		await write(file, 'export enum State { Active }\nexport interface Wrong {}\nexport type wrong = string;');
		const output = await check(domain, true);
		assert.match(output, /Interface "Wrong"/);
		assert.match(output, /Type "wrong"/);
		await write(file, Array.from({ length: 6 }, (_, i) => `export type TState${i} = string;`).join('\n'));
		assert.match(await check(domain, true), /Maximum is 5/);
		await write(file, 'export enum State { Active }\nexport interface IState {}\nexport type TState = string;');
		await check(domain);
	}));

test('Domain barrels allow exports but not declarations, imports or executable code', () =>
	fixture(async (write) => {
		const file = 'src/app/Contexts/Orders/Domain/index.ts';
		for (const code of [
			"export * from './Entities/Order';",
			"export type { IOrder } from './Entities/Order';",
			"export * as Order from './Entities/Order';",
			'// comment\n'
		]) {
			await write(file, code);
			await check(domain);
		}
		for (const code of [
			'export interface IOrder {}',
			'export type TOrder = string;',
			"import './Entities/Order';",
			'export default {};',
			'console.log(1);'
		]) {
			await write(file, code);
			assert.match(await check(domain, true), /only exports/);
		}
	}));

test('AST excludes declaration-like strings, regexes and imported interface names', () =>
	fixture(async (write) => {
		await write(
			'src/app/Contexts/Orders/Domain/Entities/Order.ts',
			`
 import { interface as label } from 'external';
 const pattern = /interface Wrong/;
 const example = 'type Wrong = string';
 export declare interface IOrder {}
 export type TOrder<T> = T;
 `
		);
		await check(domain);
		assert.deepEqual(
			dependencies(
				`const regex = /import('bad')/; obj.import('bad'); const x = \`text import('bad')\`; const y = \`x\${import('good')}\`;`
			).map((x) => x.source),
			['good']
		);
	}));

test('all-inline-type imports form the type group, mixed imports remain values', () =>
	fixture(async (write) => {
		const file = 'src/app/Platform/Test.ts';
		await write(file, "import {X} from 'a'; import {type A, type B as C} from 'b'; import 'c';");
		await check(imports);
		await write(file, "import {type A} from 'a'; import {B} from 'b';");
		await check(imports, true);
		await write(file, "import {type A, B} from 'a'; import {C} from 'b';");
		await check(imports);
		await write(file, "import type from 'a'; import {C} from 'b';");
		await check(imports);
	}));

test('Svelte scripts, import-type nodes and escaped literal imports are detected accurately', () =>
	fixture(async (write) => {
		assert.deepEqual(
			dependencies(
				`<!-- <script>import 'fake'</script> -->\n<p>import 'fake'</p>\n<script lang="ts">\nimport { type A } from 'a';\nconst x = import('b');\n</script>`,
				'Test.svelte'
			).map((x) => [x.source, x.line, x.kind]),
			[
				['a', 4, 'type'],
				['b', 5, 'dynamic']
			]
		);
		await write(
			'src/app/Presentation/Admin/Ui/Test.svelte',
			`<p>import '#presentation/Shop'</p><script lang="ts">const load = () => import('#presentation/Shop');</script>`
		);
		await check(boundaries, true);
		await write('src/app/Contexts/Orders/Domain/Test.ts', "type TForeign = import('#contexts/Billing/Domain/X').X;");
		await check(boundaries, true);
		await write('src/app/Contexts/Orders/Domain/Test.ts', "import '#contexts/Bill\\u0069ng/Domain/X';");
		await check(boundaries, true);
	}));

test('flat and workspace layouts, exact Ui/Shared casing and folder naming', () =>
	fixture(async (write) => {
		await write('src/app/Presentation/Admin/Ui/Card.svelte', '');
		await write('src/app/Presentation/Shared/Ui/Card.svelte', '');
		await check(folders);
		await fs.mkdir('src/app/Presentation/Ui');
		await check(folders, true);
		await fs.rmdir('src/app/Presentation/Ui');
		await fs.rename('src/app/Presentation/Shared', 'src/app/Presentation/SHARED');
		await check(folders, true);
		await fs.rename('src/app/Presentation/SHARED', 'src/app/Presentation/Shared');
		await fs.mkdir('src/app/Presentation/UI');
		assert.match(await check(folders, true), /canonical folder name "Ui"/);
		await fs.rmdir('src/app/Presentation/UI');
		await fs.mkdir('src/app/Presentation/Admin/index.ts');
		await check(folders, true);
	}));

test('workspace root barrels do not bypass isolation', () =>
	fixture(async (write) => {
		await write('src/app/Presentation/Admin/Ui/Test.ts', "export * from '#presentation/Shop';");
		await check(boundaries, true);
		await write('src/app/Presentation/Admin/Ui/Test.ts', "export * from '#presentation/Shared';");
		await check(boundaries);
		await write('src/app/Presentation/Shared/Ui/Test.ts', "import '#presentation/Admin';");
		await check(boundaries, true);
	}));
