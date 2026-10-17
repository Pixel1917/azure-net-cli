import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { migrateAsyncHelpers, migratePresenterSource } from '../src/migrate/presenters.js';
import { planMigration, applyMigration } from '../src/migrate/migrate.js';

const source = `import { AppPresenter } from '#platform/Foundation/Presenter';
import { ApplicationProvider } from '#platform/Foundation/DI';
export const OrdersPresenter = AppPresenter('Orders', ({ createAsyncResource }) => {
 const { Orders: orders } = ApplicationProvider();
 let count = 0;
 const collection = () => createAsyncResource(() => orders.collection(++count));
 return { collection, get count() { return count; } };
});`;

test('migration preserves closure state, constructor injection and detached callbacks', async () => {
	const result = migratePresenterSource(source, 'OrdersPresenter.ts', new Set(['AppPresenter']));
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /export class OrdersPresenter/);
	assert.match(result.content, /export const useOrdersPresenter = RegisterProvider/);
	assert.doesNotMatch(result.content, /AppPresenter/);
	const exports = {};
	vm.runInNewContext(
		ts.transpileModule(result.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
		{
			exports,
			require(name) {
				if (name === '@azure-net/kit/delivery')
					return { RegisterProvider: (factory) => factory, createAsyncResource: (action) => action() };
				if (name === '#platform/Foundation/DI') return { ApplicationProvider: () => ({ Orders: { collection: async (count) => count } }) };
				throw new Error(name);
			}
		}
	);
	const presenter = exports.useOrdersPresenter();
	const { collection } = presenter;
	assert.equal(await collection(), 1);
	assert.equal(await collection(), 2);
	assert.equal(presenter.count, 2);
	assert.equal(exports.useOrdersPresenter().count, 0);
	assert.equal(await new exports.OrdersPresenter({ collection: async () => 42 }).collection(), 42);
});

test('unsupported injected dependencies are reported without deleting user code', () => {
	const input = source.replace('{ createAsyncResource }', '{ createAsyncResource, CurrentUser }');
	const result = migratePresenterSource(input, 'Presenter.ts', new Set(['AppPresenter']));
	assert.equal(result.content, input);
	assert.equal(result.converted.size, 0);
	assert.match(result.issues[0], /CurrentUser/);
});

test('mixed old/new files reuse existing helper and registration imports', () => {
	const input = `import { RegisterProvider, createAsyncResource } from '@azure-net/kit/delivery';\n` + source;
	const result = migratePresenterSource(input, 'OrdersPresenter.ts', new Set(['AppPresenter']));
	assert.deepEqual(result.issues, []);
	const parsed = ts.createSourceFile('OrdersPresenter.ts', result.content, ts.ScriptTarget.Latest, true);
	const bindings = parsed.statements.filter(ts.isImportDeclaration).flatMap((s) => s.importClause?.namedBindings?.elements ?? []);
	assert.equal(bindings.filter((binding) => binding.name.text === 'RegisterProvider').length, 1);
	assert.equal(bindings.filter((binding) => binding.name.text === 'createAsyncResource').length, 1);
});

test('JavaScript presenters remain valid JavaScript after migration', () => {
	const result = migratePresenterSource(source, 'OrdersPresenter.js', new Set(['AppPresenter']));
	assert.deepEqual(result.issues, []);
	assert.doesNotMatch(result.content, /ReturnType|typeof ApplicationProvider/);
	assert.match(result.content, /constructor\(orders\)/);
});

test('helper upgrade preserves error type specialization and import aliases', () => {
	const input = `import { createAsyncHelpers as helpers, createSchemaFactory } from '@azure-net/kit/delivery';
const { createAsyncAction } = helpers<{ code: string }>();
const plain = helpers();`;
	const output = migrateAsyncHelpers(input, 'Example.ts');
	assert.doesNotMatch(output, /createAsyncHelpers|helpers\(/);
	assert.match(output, /createSchemaFactory/);
	assert.match(output, /Res, Req, \{ code: string \}/);
	assert.match(output, /createAsyncAction as kitCreateAsyncAction/);
	assert.equal(migrateAsyncHelpers(output, 'Example.ts'), output);
});

test('helper upgrade keeps Svelte markup intact', () => {
	const input = `<script lang="ts">import { createAsyncHelpers } from '@azure-net/kit/delivery'; const helpers = createAsyncHelpers();</script><h1>hello</h1>`;
	const output = migrateAsyncHelpers(input, 'Example.svelte');
	assert.match(output, /<\/script><h1>hello<\/h1>$/);
	assert.doesNotMatch(output, /createAsyncHelpers/);
});

test('upgrades an already migrated architecture, rewrites consumers and does not rebuild DI', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-presenter-migration-'));
	const put = async (file, data) => {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.writeFile(path.join(root, file), data);
	};
	try {
		await put('azure-net.config.ts', `export default { defaultPresenterFactory: 'AppPresenter', presentationWorkspaces: ['Admin'] };`);
		await put(
			'package.json',
			JSON.stringify({ imports: { '#platform/*': './src/app/Platform/*', '#presentation/*': './src/app/Presentation/*' } })
		);
		await put(
			'src/app/Platform/Foundation/Presenter/AppPresenter.ts',
			`import { createPresenterFactory, createAsyncHelpers } from '@azure-net/kit/delivery'; export const AppPresenter = createPresenterFactory({...createAsyncHelpers()});`
		);
		await put('src/app/Platform/Foundation/Presenter/index.ts', `export * from './AppPresenter';`);
		const di = 'export const ApplicationProvider = () => ({ Orders: { collection: async () => [] } });';
		await put('src/app/Platform/Foundation/DI/index.ts', di);
		const presenterFile = 'src/app/Presentation/Admin/Scopes/Orders/OrdersPresenter.ts';
		await put(presenterFile, source);
		await put('src/app/Presentation/Admin/Scopes/Orders/index.ts', `export { OrdersPresenter as Orders } from './OrdersPresenter';`);
		await put(
			'src/routes/+page.svelte',
			`<script lang="ts">import { Orders as Presenter } from '#presentation/Admin/Scopes/Orders'; const p = Presenter();</script><p>Orders</p>`
		);
		await put(
			'src/routes/+page.ts',
			`import * as presenters from '#presentation/Admin/Scopes/Orders/OrdersPresenter'; export const load = () => presenters.OrdersPresenter().collection();`
		);
		const plan = await planMigration(root);
		assert.equal(plan.moves.length, 0);
		assert.equal(plan.issues.length, 0, JSON.stringify(plan.issues));
		assert.match(plan.writes.get(path.join(root, presenterFile)).toString(), /export class OrdersPresenter/);
		assert.match(plan.writes.get(path.join(root, 'src/routes/+page.svelte')).toString(), /useOrdersPresenter as Presenter/);
		assert.match(plan.writes.get(path.join(root, 'src/routes/+page.ts')).toString(), /presenters.useOrdersPresenter\(\)/);
		assert.match(
			plan.writes.get(path.join(root, 'src/app/Presentation/Admin/Scopes/Orders/index.ts')).toString(),
			/useOrdersPresenter as Orders/
		);
		await applyMigration(plan);
		assert.equal(await fs.readFile(path.join(root, 'src/app/Platform/Foundation/DI/index.ts'), 'utf8'), di);
		assert.doesNotMatch(await fs.readFile(path.join(root, 'azure-net.config.ts'), 'utf8'), /defaultPresenterFactory/);
		await assert.rejects(planMigration(root), /Nothing to migrate/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('custom dependencies keep identity and helper error types without presenter factories', async () => {
	const { inspectFactories, replaceFactory } = await import('../src/migrate/presenterFactories.js');
	const factory = `import {createPresenterFactory, createAsyncHelpers} from '@azure-net/kit/delivery';
 import {notify} from 'ui';
 export const {createAsyncResource, createAsyncAction} = createAsyncHelpers<{apiStatus?:number}>();
 export const AppPresenter = createPresenterFactory({createAsyncResource,createAsyncAction,notify:()=>notify});`;
	const [definition] = inspectFactories(factory, 'Factory.ts');
	const input = `import {AppPresenter} from './Factory';
 import {ApplicationProvider} from './DI';
 export const ExamplePresenter = AppPresenter('Example', ({createAsyncAction: action, createAsyncResource, notify: notifications}) => {
 const {Orders} = ApplicationProvider();
 const notify = notifications();
 let count=0;
 const execute=()=>action(async()=>{notify(++count);return Orders.get();});
 const resource=()=>createAsyncResource(()=>Orders.get());
 return {execute,resource,get count(){return count;}};
 });`;
	const result = migratePresenterSource(
		input,
		'Example.ts',
		new Set(['AppPresenter']),
		new Map([['AppPresenter', { ...definition, source: './Factory' }]])
	);
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /createAsyncAction as kitCreateAsyncAction/);
	assert.match(result.content, /const action: typeof ExamplePresenterDependencies\["createAsyncAction"\]/);
	const migratedFactory = migrateAsyncHelpers(replaceFactory(factory, 'Factory.ts', definition, false), 'Factory.ts');
	assert.doesNotMatch(migratedFactory, /createPresenterFactory|createAsyncHelpers/);
	assert.match(migratedFactory, /apiStatus\?:number/);
	const notifications = [];
	const kit = { RegisterProvider: (factory) => factory, createAsyncAction: (fn) => fn(), createAsyncResource: (fn) => fn() };
	const compile = (text, require) => {
		const exports = {};
		vm.runInNewContext(
			ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
			{ exports, require }
		);
		return exports;
	};
	const deps = compile(migratedFactory, (name) => (name === 'ui' ? { notify: (value) => notifications.push(value) } : kit));
	const exports = compile(result.content, (name) =>
		name === './Factory' ? deps : name === './DI' ? { ApplicationProvider: () => ({ Orders: { get: () => 42 } }) } : kit
	);
	const presenter = exports.useExamplePresenter();
	const { execute, resource } = presenter;
	assert.equal(await execute(), 42);
	assert.equal(await execute(), 42);
	assert.equal(await resource(), 42);
	assert.deepEqual(notifications, [1, 2]);
	assert.equal(presenter.count, 2);
	assert.equal(exports.useExamplePresenter().count, 0);
});

test('factory analysis rejects opaque spreads, accessors and custom overrides', async () => {
	const { inspectFactories } = await import('../src/migrate/presenterFactories.js');
	for (const config of ['{...unknown}', '{get notify(){return fn;}}']) {
		assert.deepEqual(
			inspectFactories(
				`import {createPresenterFactory} from '@azure-net/kit/delivery'; export const AppPresenter=createPresenterFactory(${config});`,
				'Factory.ts'
			),
			[]
		);
	}
	const [factory] = inspectFactories(
		`import {createPresenterFactory} from '@azure-net/kit/delivery'; export const AppPresenter=createPresenterFactory({createAsyncResource: customResource});`,
		'Factory.ts'
	);
	assert.equal(factory.helpers.size, 0);
	const result = migratePresenterSource(
		source,
		'Example.ts',
		new Set(['AppPresenter']),
		new Map([['AppPresenter', { ...factory, source: './Factory' }]])
	);
	assert.match(result.content, /constructor\(createAsyncResource:/);
	assert.doesNotMatch(result.content, /createAsyncResource as kit/);
});

test('registration import collisions and no-name presenter factories are supported', () => {
	const input = "const RegisterProvider = 'local';\n" + source.replace("AppPresenter('Orders',", 'AppPresenter(');
	const result = migratePresenterSource(input, 'Example.ts', new Set(['AppPresenter']));
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /RegisterProvider as RegisterProvider_/);
	assert.match(result.content, /useOrdersPresenter = RegisterProvider_\(/);
});

test('local injections and explicit factory generics are not silently discarded', () => {
	for (const input of [
		source.replace('});', '}, {custom: 1});'),
		source.replace("AppPresenter('Orders'", "AppPresenter<SomeType>('Orders'")
	]) {
		const result = migratePresenterSource(input, 'Example.ts', new Set(['AppPresenter']));
		assert.equal(result.content, input);
		assert.equal(result.converted.size, 0);
		assert.equal(result.issues.length, 1);
	}
});

test('generated custom dependency classes pass strict TypeScript checking', async () => {
	const { inspectFactories, replaceFactory } = await import('../src/migrate/presenterFactories.js');
	const factory = `import {createPresenterFactory,createAsyncHelpers} from '@azure-net/kit/delivery';
 export const {createAsyncResource}=createAsyncHelpers<{status?:number}>();
 export const AppPresenter=createPresenterFactory({createAsyncResource,notify:()=>((value:string)=>value)});`;
	const [definition] = inspectFactories(factory, 'Factory.ts');
	const input = `import {AppPresenter} from './Factory';
 export const ExamplePresenter=AppPresenter('Example',({createAsyncResource,notify})=>{
 const resource=()=>createAsyncResource<string>(()=>Promise.resolve(notify()('ok')));
 return {resource};
 });`;
	const result = migratePresenterSource(
		input,
		'Example.ts',
		new Set(['AppPresenter']),
		new Map([['AppPresenter', { ...definition, source: './Factory' }]])
	);
	assert.deepEqual(result.issues, []);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'presenter-typecheck-'));
	try {
		await fs.writeFile(
			path.join(root, 'Factory.ts'),
			migrateAsyncHelpers(replaceFactory(factory, 'Factory.ts', definition, false), 'Factory.ts')
		);
		await fs.writeFile(path.join(root, 'Example.ts'), result.content);
		await fs.writeFile(
			path.join(root, 'kit.d.ts'),
			`declare module '@azure-net/kit/delivery' {
 export function RegisterProvider<T>(factory:()=>T,lifecycle:'scoped'):()=>T;
 export function createAsyncResource<Res=never,Req=never,E=unknown>(handler:()=>Promise<Res>): {response:Res;error:E};
 export const createAsyncAction: typeof createAsyncResource;
 }`
		);
		const files = ['Factory.ts', 'Example.ts', 'kit.d.ts'].map((f) => path.join(root, f));
		const program = ts.createProgram(files, {
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS
		});
		const diagnostics = ts.getPreEmitDiagnostics(program);
		assert.deepEqual(
			diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
			[]
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('same-file references migrate but local shadows remain untouched', () => {
	const input =
		source +
		`
 export const accessor=OrdersPresenter;
 export const registry={OrdersPresenter};
 export type Instance=ReturnType<typeof OrdersPresenter>;
 function local(OrdersPresenter:()=>number){return OrdersPresenter();}
 export const current=OrdersPresenter();`;
	const result = migratePresenterSource(input, 'OrdersPresenter.ts', new Set(['AppPresenter']));
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /accessor=useOrdersPresenter/);
	assert.match(result.content, /OrdersPresenter: useOrdersPresenter/);
	assert.match(result.content, /ReturnType<typeof useOrdersPresenter>/);
	assert.match(result.content, /local\(OrdersPresenter:\(\)=>number\)\{return OrdersPresenter\(\);\}/);
	assert.match(result.content, /current=useOrdersPresenter\(\)/);
	assert.match(result.content, /return new OrdersPresenter\(/);
});

test('repairs presenters when a previous migration already flattened async helpers', async () => {
	const { inspectFactories } = await import('../src/migrate/presenterFactories.js');
	const factory = migrateAsyncHelpers(
		`import {createPresenterFactory,createAsyncHelpers} from '@azure-net/kit/delivery';
 export const {createAsyncResource}=createAsyncHelpers<{code:string}>();
 export const AppPresenter=createPresenterFactory({createAsyncResource,notify:()=>({})});`,
		'Factory.ts'
	);
	const [definition] = inspectFactories(factory, 'Factory.ts');
	assert.equal(definition.helpers.has('createAsyncResource'), true);
	const result = migratePresenterSource(
		source,
		'Example.ts',
		new Set(['AppPresenter']),
		new Map([['AppPresenter', { ...definition, source: './Factory' }]])
	);
	assert.deepEqual(result.issues, []);
	assert.match(result.content, /createAsyncResource as kitCreateAsyncResource/);
	assert.doesNotMatch(result.content, /constructor\(createAsyncResource:/);
});
