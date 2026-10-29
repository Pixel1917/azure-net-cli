import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import boundaries from '../src/checks/checkLayerBoundaries.js';
import layers from '../src/checks/checkLayerImports.js';
import folders from '../src/checks/checkFoldersStructure.js';
import domain from '../src/checks/checkDomain.js';
import imports from '../src/checks/checkImports.js';
import internal from '../src/checks/checkInternal.js';
import presenters from '../src/checks/checkPresenterNames.js';
import providerNames from '../src/checks/checkProviderNames.js';
import providerGraph from '../src/checks/checkProviderGraph.js';
import hooks from '../src/checks/checkHooks.js';
import project from '../src/checks/checkProject.js';
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
		for (const context of ['Orders/Order', 'Billing/Invoice'])
			for (const folder of ['Domain/Entities', 'Domain/Ports', 'Domain/Enums', 'Application/UseCases', 'Infrastructure/Repositories'])
				await fs.mkdir(path.join(root, 'src/app/Contexts', context, folder), { recursive: true });
		for (const folder of ['app/Presentation', 'platform', 'app/Contexts/SharedKernel/Contracts', 'app/Contexts/SharedKernel/Domain'])
			await fs.mkdir(path.join(root, 'src', folder), { recursive: true });
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
	"import X from '#contexts/Billing/Invoice/Domain/Entities/X'",
	"export * from '#contexts/Billing/Invoice/Domain/Entities/X'",
	"export {X} from '#contexts/Billing/Invoice/Domain/Entities/X'",
	"import('#contexts/Billing/Invoice/Domain/Entities/X')",
	"import '../../../Billing/Invoice/Domain/Entities/X'",
	"import('#contexts/Billing/Invoice/Domain/Entities/X', {with:{type:'json'}})"
]) {
	test(`rejects cross-context ${statement}`, () =>
		fixture(async (write) => {
			await write('src/app/Contexts/Orders/Order/Domain/Test.ts', statement);
			await check(boundaries, true);
		}));
}
test('SharedKernel is one-way, context isolation includes Presentation', () =>
	fixture(async (write) => {
		await write('src/app/Contexts/Orders/Order/Domain/Test.ts', "import '#contexts/SharedKernel/Domain/Entities/X'");
		await check(boundaries);
		await write('src/app/Contexts/SharedKernel/Domain/Test.ts', "import '#contexts/Orders/Order/Domain/Entities/X'");
		await check(boundaries, true);
		await write('src/app/Contexts/SharedKernel/Domain/Test.ts', "import '#presentation/Ui/X'");
		await check(boundaries, true);
		await check(layers, true);
	}));
test('layer direction retains Application to Infrastructure', () =>
	fixture(async (write) => {
		await write('src/app/Contexts/Orders/Order/Application/Test.ts', "import '#contexts/Orders/Order/Infrastructure/Repositories/X'");
		await check(layers);
		await write('src/app/Contexts/Orders/Order/Domain/Test.ts', "export * from '../Infrastructure/Repositories/X'");
		await check(layers, true);
		await write('src/app/Contexts/Orders/Order/Domain/Test.ts', '');
		await write('src/app/Contexts/Orders/Order/Infrastructure/Test.ts', "import('../Application/UseCases/X')");
		await check(layers, true);
	}));
test('real Svelte aliases including wildcard and absolute targets', () =>
	fixture(async (write) => {
		await write(
			'svelte.config.js',
			`export default {kit:{alias:{'@billing/*':'./src/app/Contexts/Billing/Invoice/*', '@ui':${JSON.stringify(path.join(process.cwd(), 'src/app/Presentation'))}}}};`
		);
		await write('src/app/Contexts/Orders/Order/Domain/Test.ts', "import '@billing/Domain/X'");
		await check(boundaries, true);
		await write('src/app/Contexts/Orders/Order/Domain/Test.ts', "import '@ui/Ui/X'");
		await check(boundaries, true);
	}));
test('workspace isolation and Shared direction; routes and Platform compose contexts', () =>
	fixture(async (write) => {
		await write('src/app/Presentation/Admin/Ui/Test.ts', "import '#presentation/Shared/Ui/X'");
		await write('src/routes/Test.ts', "import '#contexts/Orders/Order/Domain/X'; import '#contexts/Billing/Invoice/Domain/X'");
		await write(
			'src/platform/Foundation/DI/Test.ts',
			"import '#contexts/Orders/Order/Domain/X'; import '#contexts/Billing/Invoice/Domain/X'"
		);
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
		await write('src/app/Presentation/Public/Ui/Components/Core/Card.svelte', '');
		await write('src/platform/index.ts', "export * as DI from './Foundation/DI';");
		await check(folders);
		await fs.mkdir('src/app/Contexts/Orders/Order/badName');
		await check(folders, true);
		await fs.rmdir('src/app/Contexts/Orders/Order/badName');
		await write('src/platform/index.ts', 'export const Bad = 1;');
		await check(folders);
		await write('src/platform/index.ts', '');
		await fs.mkdir('src/app/Contexts/Orders/Order/Wrong');
		await check(folders, true);
	}));
test('domain names, generic aliases and enums without declaration-count limits', () =>
	fixture(async (write) => {
		await write('src/app/Contexts/Orders/Order/Domain/Entities/Order.ts', 'export interface IOrder {}\nexport type TOrder<T> = T;');
		await check(domain);
		await write('src/app/Contexts/Orders/Order/Domain/Enums/StateEnum.ts', 'export enum StateEnum { Active }');
		await check(domain);
		await write('src/app/Contexts/Orders/Order/Domain/Ports/IPort.ts', 'export interface Bad {}');
		await check(domain, true);
		await fs.rm('src/app/Contexts/Orders/Order/Domain/Ports/IPort.ts');
		await write(
			'src/app/Contexts/Orders/Order/Domain/Entities/Order.ts',
			Array.from({ length: 6 }, (_, i) => `export type TItem${i}<T> = T;`).join('\n')
		);
		await check(domain);
	}));
test('import styles include dynamic imports and reexports', () =>
	fixture(async (write) => {
		await write('src/platform/Test.ts', "import('./Other.ts'); export * from './Other.js';");
		await check(imports, true);
		await write('src/platform/Test.ts', "import type {T} from './Other'; import {X} from './Other'");
		await check(imports, true);
	}));
test('provider and hooks regressions and internal runs every check after failure', () =>
	fixture(async (write) => {
		await check(internal);
		await write(
			'src/platform/Test.ts',
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

test('Enums retains interface/type naming without a declaration-count limit', () =>
	fixture(async (write) => {
		const file = 'src/app/Contexts/Orders/Order/Domain/Enums/StateEnum.ts';
		await write(file, 'export enum StateEnum { Active }\nexport interface Wrong {}\nexport type wrong = string;');
		const output = await check(domain, true);
		assert.match(output, /Interface "Wrong"/);
		assert.match(output, /Type "wrong"/);
		await write(file, Array.from({ length: 6 }, (_, i) => `export type TState${i} = string;`).join('\n'));
		await check(domain);
		await write(file, 'export enum StateEnum { Active }\nexport interface IState {}\nexport type TState = string;');
		await check(domain);
	}));

test('Domain barrels allow exports but not declarations, imports or executable code', () =>
	fixture(async (write) => {
		const file = 'src/app/Contexts/Orders/Order/Domain/index.ts';
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
			'src/app/Contexts/Orders/Order/Domain/Entities/Order.ts',
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
		const file = 'src/platform/Test.ts';
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
		await write('src/app/Contexts/Orders/Order/Domain/Test.ts', "type TForeign = import('#contexts/Billing/Invoice/Domain/X').X;");
		await check(boundaries, true);
		await write('src/app/Contexts/Orders/Order/Domain/Test.ts', "import '#contexts/Bill\\u0069ng/Domain/X';");
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
		assert.match(await check(folders, true), /Allowed folders|PascalCase|AppBoundary/);
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

test('same-context aggregates and SharedKernel contracts are allowed, layer direction remains enforced', () =>
	fixture(async (write) => {
		const file = 'src/app/Contexts/Orders/Order/Application/UseCases/OrderUseCases.ts';
		await write(
			file,
			"import type {ICartRepository} from '#contexts/Orders/Cart/Domain/Ports'; import type {IContract} from '#contexts/SharedKernel/Contracts/Orders';"
		);
		await check(boundaries);
		await check(layers);
		await write(
			'src/app/Contexts/Orders/Order/Domain/Test.ts',
			"import '#contexts/Orders/Cart/Infrastructure/Repositories/CartRepository';"
		);
		await check(layers, true);
	}));

test('aggregate layers, SharedKernel shape and Presentation component categories', () =>
	fixture(async (write) => {
		for (const directory of [
			'Contexts/Orders/Order/Domain/Resources',
			'Contexts/Orders/Order/Domain/DTO',
			'Contexts/Orders/Order/Application/Services',
			'Contexts/Orders/Order/Infrastructure/Services',
			'Presentation/Public/Scopes',
			'Presentation/Public/Shell',
			'Presentation/Public/Ui/Actions',
			'Presentation/Public/Ui/Style',
			...['Scopes', 'Composite', 'Page', 'Core'].map((name) => `Presentation/Public/Ui/Components/${name}`)
		])
			await fs.mkdir(`src/app/${directory}`, { recursive: true });
		await check(folders);
		for (const directory of [
			'src/app/Platform',
			'src/app/Presentation/Public/Ui/Widgets',
			'src/app/Presentation/Public/Ui/Components/Atoms',
			'src/app/Contexts/SharedKernel/Application',
			'src/app/Contexts/Orders/Order/Domain/Bad-Name',
			'src/app/Contexts/Orders/Order/Shared',
			'src/platform/Shared',
			...['Consts', 'consts', 'utils', 'Utils', 'common', 'Common'].map((name) => `src/${name}`)
		]) {
			await fs.mkdir(directory, { recursive: true });
			await check(folders, true);
			await fs.rm(directory, { recursive: true });
		}
		await fs.rm('src/app/Contexts/Orders/Order/Infrastructure', { recursive: true });
		await check(folders, true);
	}));

test('context interfaces, resources, repository/usecase names and global enums', () =>
	fixture(async (write) => {
		for (const [file, code, expected] of [
			['src/app/Contexts/Orders/Order/Application/Services/Service.ts', 'export interface Bad {}', /Interface "Bad"/],
			['src/app/Contexts/Orders/Order/Domain/Resources/Order.ts', 'export interface IOrder {}', /must end with Resource/],
			['src/app/Contexts/Orders/Order/Infrastructure/Repositories/OrderRepository.ts', 'export class Bad {}', /must end with Repository/],
			['src/app/Contexts/Orders/Order/Application/UseCases/OrderUseCases.ts', 'export interface IOrder {}', /must end with UseCases/],
			['src/platform/State.ts', 'export enum State { On }', /must end with Enum/],
			['src/routes/State.ts', 'export enum StateEnum { On }', /file name must end with Enum/]
		]) {
			await write(file, code);
			assert.match(await check(domain, true), expected);
			await fs.rm(file);
		}
		await write('src/app/Contexts/Orders/Order/Domain/Resources/OrderResource.ts', 'export interface IOrderResource {}');
		await write('src/platform/StateEnum.ts', 'export enum StateEnum { On }');
		await check(domain);
	}));

test('constructor dependency interfaces, imported aliases, defaults and store exceptions', () =>
	fixture(async (write) => {
		for (const [file, owner] of [
			['src/app/Contexts/Orders/Order/Infrastructure/Repositories/OrderRepository.ts', 'OrderRepository'],
			['src/app/Contexts/Orders/Order/Application/UseCases/OrderUseCases.ts', 'OrderUseCases'],
			['src/app/Presentation/Public/Scopes/Order/OrderPresenter.ts', 'OrderPresenter']
		]) {
			for (const parameter of [
				'repo: OrderRepository',
				'source: ApiDatasource',
				'useCases: OrderUseCases',
				'repo: any',
				'repo = new OrderRepository()',
				'source: Concrete',
				'repo: IOrderRepository | OrderRepository'
			]) {
				await write(file, `import { ApiDatasource as Concrete } from 'external'; export class ${owner} { constructor(${parameter}) {} }`);
				assert.match(await check(domain, true), /must use an interface/);
			}
			await write(
				file,
				`import type { IOrderRepository as Port } from 'external'; export class ${owner} { constructor(repo: Port, datasource: IApiDatasource, useCases: IOrderUseCases, private storage = LocalStorageUtil.createInstance('key'), private cookie = Cookie.createInstance('key'), store: OrderStore) {} }`
			);
			await check(domain);
			await fs.rm(file);
		}
	}));

test('contexts prohibit top-level functions but permit class methods and nested CompositionRoot callbacks', () =>
	fixture(async (write) => {
		const file = 'src/app/Contexts/Orders/Composition.ts';
		for (const code of [
			'export function helper() {}',
			'const helper = () => 1;',
			'const helper = function() {};',
			'export default () => 1;',
			'const helper = (() => 1) as unknown;',
			'const callbacks = { run: () => 1 };'
		]) {
			await write(file, code);
			assert.match(await check(domain, true), /top-level functions/);
		}
		await write(
			file,
			`import { CompositionRoot as Root } from '@azure-net/kit';
export const OrdersContext = new Root({ register: () => ({ Order: () => new Order() }) });
export class Order { run() { return [1].map(x => x + 1); } }
// function example() {}
const example = 'const helper = () => 1';`
		);
		await check(domain);
	}));

test('bound styles belong to the final import group', () =>
	fixture(async (write) => {
		const file = 'src/platform/Test.ts';
		await write(
			file,
			"import { value, type Inline } from 'a'; import type {Type} from 'b'; import styles from './theme.module.css'; import 'setup';"
		);
		await check(imports);
		await write(file, "import styles from './theme.module.scss?inline'; import type {Type} from 'b';");
		await check(imports, true);
	}));

test('SharedKernel-only initialization needs no concrete aggregate layers', () =>
	fixture(async () => {
		await fs.rm('src/app/Contexts/Orders', { recursive: true });
		await fs.rm('src/app/Contexts/Billing', { recursive: true });
		await fs.mkdir('src/app/Presentation/Shared/Ui/Components/Core', { recursive: true });
		await check(folders);
		await check(internal);
	}));

test('global context barrel cannot bypass context isolation', () =>
	fixture(async (write) => {
		await write('src/app/Contexts/Orders/Composition.ts', "import { Billing } from '#contexts';");
		await check(boundaries, true);
	}));

test('default-imported concrete dependency names are not hidden by aliases', () =>
	fixture(async (write) => {
		await write(
			'src/app/Presentation/Public/Scopes/Order/OrderPresenter.ts',
			`
import Dependency from '#contexts/Orders/Order/Infrastructure/Repositories/OrderRepository';
export class OrderPresenter { constructor(private dependency: Dependency) {} }
`
		);
		assert.match(await check(domain, true), /must use an interface/);
	}));

test('project checks never invoke mutating format; opt into format:check explicitly', () =>
	fixture(async (write) => {
		const original = childProcess.execSync;
		const calls = [];
		try {
			childProcess.execSync = (command) => {
				calls.push(command);
			};
			syncBuiltinESMExports();
			await write('azure-net.config.ts', "export default { packageManager: 'pnpm' };");
			await write('package.json', JSON.stringify({ scripts: { format: 'prettier --write .', lint: 'eslint .', check: 'tsc --noEmit' } }));
			await write('src/platform/Untouched.ts', 'export const unchanged=1;');
			assert.match(await check(project), /Skipping formatting: no format:check/);
			assert.deepEqual(calls, ['pnpm run lint', 'pnpm run check']);
			assert.equal(await fs.readFile('src/platform/Untouched.ts', 'utf8'), 'export const unchanged=1;');
			calls.length = 0;
			await write('package.json', JSON.stringify({ scripts: { format: 'prettier --write .', 'format:check': 'prettier --check .' } }));
			await check(project);
			assert.deepEqual(calls, ['pnpm run format:check', 'pnpm run lint', 'pnpm run check']);
			calls.length = 0;
			childProcess.execSync = (command) => {
				calls.push(command);
				throw new Error('Formatting check failed');
			};
			syncBuiltinESMExports();
			assert.match(await check(project, true), /Formatting check failed/);
			assert.deepEqual(calls, ['pnpm run format:check']);
		} finally {
			childProcess.execSync = original;
			syncBuiltinESMExports();
		}
	}));

test('utility directory prohibition is recursive and case insensitive throughout src', () =>
	fixture(async () => {
		for (const parent of [
			'src',
			'src/platform/Deep/Nested',
			'src/routes/Feature',
			'src/app/Contexts/Orders/Order/Domain',
			'src/app/Presentation/Public/Scopes/Order'
		]) {
			for (const name of ['Consts', 'cOnStS', 'Utils', 'UTILS', 'common', 'CoMmOn']) {
				const directory = `${parent}/${name}`;
				await fs.mkdir(directory, { recursive: true });
				assert.match(await check(folders, true), /prohibited throughout src/);
				await fs.rm(directory, { recursive: true });
			}
		}
		await check(folders);
	}));

test('app files use PascalCase with explicit index, module, svelte and declaration exceptions', () =>
	fixture(async (write) => {
		const root = 'src/app/Presentation/Public/Scopes/Order';
		for (const name of [
			'index.ts',
			'OrderPresenter.ts',
			'OrderStore.svelte.ts',
			'OrderStore.svelte.js',
			'Style.module.scss',
			'Style.module.css',
			'Component.svelte',
			'Types.d.ts'
		])
			await write(`${root}/${name}`);
		await write('src/routes/+page.svelte');
		await check(folders);
		// Case-insensitive filesystems preserve the original directory-entry casing.
		for (const name of await fs.readdir(root)) await fs.rm(`${root}/${name}`);
		for (const name of [
			'orderPresenter.ts',
			'orderStore.svelte.ts',
			'style.module.scss',
			'Order-Presenter.ts',
			'Order.wrong.ts',
			'index.js'
		]) {
			await write(`${root}/${name}`);
			assert.match(await check(folders, true), /App files must use PascalCase/);
			await fs.rm(`${root}/${name}`);
		}
	}));

test('Services require Service suffix for files, classes and interfaces', () =>
	fixture(async (write) => {
		const root = 'src/app/Contexts/Orders/Order/Application/Services';
		for (const [name, code, expected] of [
			['Order.ts', 'export class OrderService {}', /File name must end with Service/],
			['OrderService.ts', 'export class Order {}', /Class\/interface name must end with Service/],
			['OrderService.ts', 'export interface IOrder {}', /Class\/interface name must end with Service/],
			['OrderService.ts', 'export interface OrderService {}', /must start with "I"/]
		]) {
			await write(`${root}/${name}`, code);
			assert.match(await check(domain, true), expected);
			await fs.rm(`${root}/${name}`);
		}
		await write(`${root}/OrderService.ts`, 'export interface IOrderService {} export class OrderService implements IOrderService {}');
		await write(`${root}/index.ts`, "export * from './OrderService';");
		await check(domain);
	}));

test('scope presenter classes and files require Presenter suffix, excluding stores and schemas', () =>
	fixture(async (write) => {
		const root = 'src/app/Presentation/Public/Scopes/Order';
		for (const [name, code, expected] of [
			['Order.ts', 'export class OrderPresenter {}', /file name must end with Presenter/],
			['OrderPresenter.ts', 'export class Order {}', /class name must end with Presenter/],
			['OrderPresenter.ts', 'export default class {}', /class name must end with Presenter/],
			['OrderPresenter.ts', 'export const OrderPresenter = class Wrong {};', /class name must end with Presenter/],
			['index.ts', 'export class OrderPresenter {}', /file name must end with Presenter/]
		]) {
			await write(`${root}/${name}`, code);
			assert.match(await check(presenters, true), expected);
			await fs.rm(`${root}/${name}`);
		}
		await write(`${root}/OrderPresenter.ts`, 'export class OrderPresenter {}');
		await write(`${root}/Stores/OrderStore.svelte.ts`, 'export class OrderStore {}');
		await write(`${root}/Schemas/OrderSchema.ts`, 'export class OrderSchema {}');
		await write(`${root}/OrderStore.svelte.ts`, 'export class OrderStore {}');
		await write(`${root}/OrderSchema.ts`, 'export class OrderSchema {}');
		await write(`${root}/Constants/Names.ts`, "const text = 'class Wrong {}'; // class Other {}\n");
		await write(`${root}/index.ts`, "export * from './OrderPresenter';");
		await write('src/app/Presentation/Public/Ui/Components/Scopes/Helper.ts', 'export class Helper {}');
		await check(presenters);
	}));

test('helpers and stores are not presenters, including classes registered through RegisterProvider', () =>
	fixture(async (write) => {
		const root = 'src/app/Presentation/Public/Scopes/Content';
		for (const file of ['Helpers/PageLoader.ts', 'Helpers/PageBlockCollectionResolver.ts', 'Page.ts', 'State.ts', 'Stores/State.ts'])
			await write(`${root}/${file}`, 'export class Helper { constructor(useCases: IPageUseCases) {} }');
		await write(`${root}/index.ts`, 'export const useState = RegisterProvider(() => new State());');
		await write(`${root}/PagePresenter.ts`, 'class InternalHelper {} export class PagePresenter {}');
		await write(`${root}/Presenters/OtherPresenter.ts`, 'export class OtherPresenter {}');
		assert.match(await check(presenters), /Analyzed 2 scope presenter classes/);
	}));

test('explicit presenter markers catch invalid names even in helper or store directories', () =>
	fixture(async (write) => {
		const root = 'src/app/Presentation/Public/Scopes/Content';
		for (const [file, code, expected] of [
			['Presenters/Page.ts', 'export class Page {}', /class name must end with Presenter/],
			['Helpers/Page.ts', 'export class PagePresenter {}', /file name must end with Presenter/],
			['Stores/PagePresenter.ts', 'export class Page {}', /class name must end with Presenter/],
			['PageStore.ts', 'export class PagePresenter {}', /file name must end with Presenter/],
			['PagePresenter.ts', 'export const Page = class {};', /class name must end with Presenter/]
		]) {
			await write(`${root}/${file}`, code);
			assert.match(await check(presenters, true), expected);
			await fs.rm(`${root}/${file}`);
		}
	}));

test('resource composition allows nested parts and supporting interfaces in the main resource file', () =>
	fixture(async (write) => {
		const root = 'src/app/Contexts/Orders/Order/Domain/Resources';
		await write(
			`${root}/PageResource/PageResource.ts`,
			`
export interface IPageParam { value: string }
interface IPageProductVariation { id: string }
export interface IPageResource { params: IPageParam[]; variations: IPageProductVariation[] }
`
		);
		await write(`${root}/PageResource/PageBlock.ts`, 'export interface IPageBlock {} export type TBlock = IPageBlock;');
		await write(`${root}/PageResource/Blocks/AccordionBlock.ts`, 'export interface IAccordionBlock {}');
		await write(`${root}/PageResource/Blocks/index.ts`, "export * from './AccordionBlock';");
		await write(`${root}/SummaryResource.ts`, 'export type ISummaryResource = { id: string }; export interface IDetails {}');
		await write(`${root}/Groups/OtherResource.ts`, 'export class OtherResource {}');
		await check(domain);
	}));

test('resource naming remains strict for standalone contracts and explicit resource files', () =>
	fixture(async (write) => {
		const root = 'src/app/Contexts/Orders/Order/Domain/Resources';
		for (const [file, code, expected] of [
			['Page.ts', 'export interface IPage {}', /File name must end with Resource/],
			['Groups/Page.ts', 'export interface IPage {}', /File name must end with Resource/],
			['PageResource.ts', 'export interface IPage {}', /must export.*ends with Resource/],
			['PageResource/PageResource.ts', 'interface IPageResource {}', /must export.*ends with Resource/],
			['PageResource/Blocks/Other.ts', 'export interface IOtherResource {}', /File name must end with Resource/],
			['PageResource/Blocks/Block.ts', 'export interface Block {}', /must start with "I"/],
			['PageResource/Blocks/Block.ts', 'export type Block = string;', /must start with "I" or "T"/]
		]) {
			await write(`${root}/${file}`, code);
			assert.match(await check(domain, true), expected);
			await fs.rm(`${root}/${file}`);
		}
	}));

test('current provider APIs discover one service container and two unnamed composition roots', () =>
	fixture(async (write) => {
		await write(
			'src/platform/HttpProvider.ts',
			`import { CreateServiceContainer as Service } from '@azure-net/kit';
export const HttpProvider = Service('Http', { register: () => ({}) });`
		);
		await write(
			'src/app/Contexts/Orders/Composition.ts',
			`import { CompositionRoot as Root } from '@azure-net/kit';
import { HttpProvider as Http } from '#platform/HttpProvider';
export const OrdersContext = new Root({ dependsOn: { renamedHttp: Http }, register: () => ({}) });`
		);
		await write(
			'src/app/Presentation/Public/Scopes/Composition.ts',
			`import * as Kit from '@azure-net/kit';
import { OrdersContext } from '#contexts/Orders/Composition';
export const PublicContext = new Kit.CompositionRoot({ dependsOn: { OrdersContext }, register: () => ({}) });`
		);
		assert.match(await check(providerGraph), /analyzed 3 service containers\/composition roots/);
		assert.match(await check(providerNames), /3 service containers\/composition roots \(1 explicit names\)/);
		await write('src/app/Presentation/Public/Scopes/OrderPresenter.ts', 'export class OrderPresenter {}');
		const output = await check(presenters);
		assert.match(output, /Analyzed 1 scope presenter classes/);
		assert.doesNotMatch(output, /No presenter declarations|No scope presenter/);
	}));

test('current provider cycles follow aliased values, barrel exports and root.resolve', () =>
	fixture(async (write) => {
		await write(
			'src/platform/A.ts',
			`import { CreateServiceContainer } from '@azure-net/kit';
import { Other as Dependency } from './Barrel';
export const A = CreateServiceContainer('A-id', { dependsOn: { differentKey: Dependency.resolve }, register: () => ({}) });`
		);
		await write(
			'src/platform/B.ts',
			`import { CompositionRoot as Root } from '@azure-net/kit';
import { A as Service } from './A';
export const B = new Root({ dependsOn: { renamed: Service }, register: () => ({}) });`
		);
		await write('src/platform/Barrel/index.ts', "export { B as Other } from '../B';");
		assert.match(await check(providerGraph, true), /A -> B -> A|B -> A -> B/);
		await check(providerNames);
	}));

test('provider cycles include self-dependencies, namespace imports and export-star barrels', () =>
	fixture(async (write) => {
		await write('src/platform/Barrel/index.ts', "export * from '../Root';");
		await write(
			'src/platform/Root.ts',
			`import { CompositionRoot } from '@azure-net/kit';
import * as Roots from './Barrel';
export const Root = new CompositionRoot({ dependsOn: { self: Roots.Root } });`
		);
		assert.match(await check(providerGraph, true), /Root -> Root/);
	}));

test('provider AST follows static config/spreads but ignores strings, comments and unrelated methods', () =>
	fixture(async (write) => {
		await write(
			'src/platform/Root.ts',
			`import { CompositionRoot, CreateServiceContainer } from '@azure-net/kit';
// CreateServiceContainer('fake', {dependsOn:{Fake}})
const example = "new CompositionRoot({dependsOn:{Fake}})";
const pattern = /CreateServiceContainer('fake')/;
object.CreateServiceContainer('fake', {});
const deps = { B };
const options = { dependsOn: { ...deps }, register: () => ({}) };
export const A = new CompositionRoot(options);
export const B = CreateServiceContainer('B', { dependsOn: { A } });`
		);
		assert.match(await check(providerGraph, true), /analyzed 2 service containers\/composition roots/);
		assert.match(await check(providerNames), /2 service containers\/composition roots/);
	}));

test('duplicate explicit service names fail; unnamed roots may reuse local names in different modules', () =>
	fixture(async (write) => {
		for (const filename of ['One', 'Two'])
			await write(
				`src/platform/${filename}.ts`,
				`import { CompositionRoot, CreateServiceContainer } from '@azure-net/kit';
export const Root = new CompositionRoot({});
export const Service = CreateServiceContainer('Duplicate', {});`
			);
		assert.match(await check(providerNames, true), /Duplicate provider name "Duplicate"/);
		await write('src/platform/Two.ts', "import { CompositionRoot } from '@azure-net/kit'; export const Root = new CompositionRoot({});");
		await check(providerNames);
		await check(providerGraph);
	}));
