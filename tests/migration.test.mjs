import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import { planMigration, applyMigration } from '../src/migrate/migrate.js';
import { updateDefaultFactoryConfig } from '../src/scaffolds/updateDefaultFactoryConfig.js';

test('generated DI shares dependencies only within one register invocation', async () =>
	fixture(async (root) => {
		const plan = await planMigration(root);
		const source = plan.writes.get(path.join(root, 'src/app/Platform/Foundation/DI/ApplicationProvider.ts')).toString();
		const code = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
		}).outputText;
		let register;
		class Api {
			constructor(config) {
				this.config = config;
			}
		}
		class OrderRepository {
			constructor(ds) {
				this.ds = ds;
			}
		}
		class OrderUseCases {
			constructor(repo) {
				this.repo = repo;
			}
		}
		vm.runInNewContext(code, {
			exports: {},
			require: (name) => {
				if (name === '@azure-net/kit')
					return {
						CreateDiContainer: (_, config) => {
							register = config.register;
						}
					};
				if (name.endsWith('/Api')) return { Api };
				if (name.endsWith('/OrderRepository')) return { OrderRepository };
				if (name.endsWith('/OrderUseCases')) return { OrderUseCases };
				throw new Error(`Unexpected generated dependency: ${name}`);
			}
		});
		const first = register();
		const second = register();
		assert.equal(first.Orders().repo, first.Orders().repo);
		assert.notEqual(first.Orders().repo, second.Orders().repo);
		assert.notEqual(first.Orders().repo.ds, second.Orders().repo.ds);
		assert.equal(first.Orders().repo.ds.config.url, 'https://api.example.com');
	}));

test('legacy folder migration also upgrades presenters and their consumers', async () =>
	fixture(async (root, put) => {
		await put(
			'src/app/shared-kernel/essentials/foundation/constructs/presenter/AppPresenter.ts',
			`import { createPresenterFactory as make } from '@azure-net/kit/delivery'; export const AppPresenter = make({});`
		);
		await put(
			'src/app/public/layers/presentation/order/OrderPresenter.ts',
			`import { AppPresenter as Presenter } from '$shared-kernel/essentials/foundation/constructs/presenter/AppPresenter';
import { PublicApplicationProvider } from '../../application/providers/ApplicationProvider';
export const OrderPresenter = Presenter('Order', ({ createAsyncResource }) => {
 const { Orders } = PublicApplicationProvider();
 const collection = () => createAsyncResource(() => Promise.resolve(Orders));
 return { collection };
});`
		);
		await put(
			'src/routes/+page.svelte',
			`<script lang="ts">import { OrderPresenter } from '$public/layers/presentation/order/OrderPresenter'; const presenter = OrderPresenter();</script>`
		);
		const plan = await planMigration(root);
		const generated = plan.writes.get(path.join(root, 'src/app/Presentation/Public/Scopes/Order/OrderPresenter.ts')).toString();
		assert.match(generated, /export class OrderPresenter/);
		assert.match(generated, /useOrderPresenter = RegisterProvider/);
		assert.match(generated, /ApplicationProvider as PublicApplicationProvider/);
		assert.doesNotMatch(generated, /AppPresenter/);
		assert.match(plan.writes.get(path.join(root, 'src/routes/+page.svelte')).toString(), /useOrderPresenter as OrderPresenter/);
	}));

async function fixture(run) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'azure-migration-'));
	const put = async (name, value) => {
		const file = path.join(root, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, value);
	};
	try {
		await put(
			'azure-net.config.ts',
			`export default { ...{...{contexts:['public','shared-kernel'], packageManager:'pnpm'},defaultSchemaFactory:'Schema'},defaultPresenterFactory:'AppPresenter' };`
		);
		await put('svelte.config.js', `export default {kit:{alias:{$public:'./src/app/public','$shared-kernel':'./src/app/shared-kernel'}}};`);
		await put('tsconfig.json', '{"compilerOptions":{"strict":true}}');
		await put('src/app/public/layers/domain/order/model/Order.ts', 'export interface IOrder { id: number }');
		await put('src/app/public/layers/domain/order/model/index.ts', "export * from './Order';");
		await put('src/app/public/layers/domain/order/index.ts', "export * from './model';");
		await put(
			'src/app/public/layers/infrastructure/http/repositories/OrderRepository.ts',
			"import type { IOrder } from '../../../domain/order'; export class OrderRepository { constructor(public ds: unknown) {} }"
		);
		await put(
			'src/app/public/layers/application/use-cases/OrderUseCases.ts',
			'export class OrderUseCases { constructor(public repo: unknown) {} }'
		);
		await put('src/app/public/layers/infrastructure/http/repositories/index.ts', "export * from './OrderRepository';");
		await put('src/app/public/layers/application/use-cases/index.ts', "export * from './OrderUseCases';");
		await put(
			'src/app/shared-kernel/essentials/foundation/constructs/datasource/Api.ts',
			'export class Api { constructor(public config: unknown) {} }'
		);
		await put(
			'src/app/shared-kernel/essentials/foundation/constructs/provider/DatasourceProvider.ts',
			`import { CreateDiContainer } from '@azure-net/kit'; import { Api } from '../datasource/Api'; export const DatasourceProvider = CreateDiContainer('Datasource', {register:()=>({Rest:()=>new Api({url:'https://api.example.com'})})});`
		);
		await put(
			'src/app/public/layers/infrastructure/providers/InfrastructureProvider.ts',
			`import { CreateDiContainer } from '@azure-net/kit'; import { DatasourceProvider } from '$shared-kernel/essentials/foundation/constructs/provider/DatasourceProvider'; import {OrderRepository} from '../http/repositories'; export const PublicInfrastructureProvider=CreateDiContainer('Infra',{dependsOn:{DatasourceProvider},register:({DatasourceProvider})=>({OrderRepository:()=>new OrderRepository(DatasourceProvider.Rest)})});`
		);
		await put(
			'src/app/public/layers/application/providers/ApplicationProvider.ts',
			`import {CreateDiContainer} from '@azure-net/kit'; import {PublicInfrastructureProvider} from '../../infrastructure/providers/InfrastructureProvider'; import {OrderUseCases} from '../use-cases'; export const PublicApplicationProvider=CreateDiContainer('App',{dependsOn:{PublicInfrastructureProvider},register:({PublicInfrastructureProvider})=>({Orders:()=>new OrderUseCases(PublicInfrastructureProvider.OrderRepository)})});`
		);
		await put(
			'src/app/public/layers/presentation/order/OrderPresenter.ts',
			"import { PublicApplicationProvider } from '../../application/providers/ApplicationProvider'; export const resolve = () => PublicApplicationProvider().Orders;"
		);
		await put(
			'src/app/public/ui/widgets/card/Component.svelte',
			`<script lang="ts">import type { IOrder } from '$public/layers/domain/order';</script><style lang="scss">@use './style';</style>`
		);
		await put('src/app/public/ui/widgets/card/style.scss', '.card { color: red }');
		await put('src/app/public/mystery/data.bin', Buffer.from([0, 255, 1, 2]));
		await put('src/routes/+page.ts', "export { OrderUseCases } from '$public/layers/application/use-cases/OrderUseCases';");
		await run(root, put);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test('migration is planned read-only, applies moves, rewrites imports/styles and rebuilds DI', async () =>
	fixture(async (root) => {
		const plan = await planMigration(root);
		assert.equal(await fs.readFile(path.join(root, 'src/app/public/ui/widgets/card/style.scss'), 'utf8'), '.card { color: red }');
		assert(!plan.issues.some((i) => i.reason.startsWith('DI not migrated')), JSON.stringify(plan.issues));
		const report = await applyMigration(plan);
		const provider = await fs.readFile(path.join(root, 'src/app/Platform/Foundation/DI/ApplicationProvider.ts'), 'utf8');
		assert.match(provider, /https:\/\/api.example.com/);
		assert.match(provider, /Orders: \(\) =>/);
		assert.doesNotMatch(provider, /dependsOn|DatasourceProvider|PublicInfrastructureProvider/);
		const transformed = ts.transpileModule(provider, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
		assert.equal(transformed.diagnostics.length, 0);
		const component = await fs.readFile(path.join(root, 'src/app/Presentation/Public/Ui/Widgets/Card/Component.svelte'), 'utf8');
		assert.match(component, /\#contexts\/Order\/Domain\/Entities\/Order/);
		assert.match(component, /\.\/Style.scss/);
		assert.match(
			await fs.readFile(path.join(root, 'src/routes/+page.ts'), 'utf8'),
			/\#contexts\/Order\/Application\/UseCases\/OrderUseCases/
		);
		assert.match(
			await fs.readFile(path.join(root, 'src/app/Presentation/Public/Scopes/Order/OrderPresenter.ts'), 'utf8'),
			/ApplicationProvider as PublicApplicationProvider/
		);
		assert.deepEqual(await fs.readFile(path.join(root, 'src/app/.backup/public/mystery/data.bin')), Buffer.from([0, 255, 1, 2]));
		await assert.rejects(fs.access(path.join(root, 'src/app/public')));
		assert.match(await fs.readFile(report, 'utf8'), /mystery/);
		const config = await fs.readFile(path.join(root, 'azure-net.config.ts'), 'utf8');
		await fs.access(path.join(root, 'svelte.config.js'));
		assert.match(await fs.readFile(path.join(root, 'package.json'), 'utf8'), /#contexts/);
		assert.doesNotMatch(config, /\.\.\.|contexts:/);
		assert.match(config, /presentationWorkspaces/);
		await assert.rejects(planMigration(root), /Nothing to migrate/);
	}));

test('refuses a changed source after preview', async () =>
	fixture(async (root, put) => {
		const plan = await planMigration(root);
		await put('src/routes/+page.ts', '// changed');
		await assert.rejects(applyMigration(plan), /changed since planning/);
		await fs.access(path.join(root, 'src/app/public'));
	}));

test('flattens only literal config spreads, preserves functions and dynamic spreads', () => {
	const source = `export default { ...{ ...{presentationWorkspaces:['Admin'],groupRoutesFunc: (route)=>route.url}, defaultSchemaFactory:'Schema' }, defaultPresenterFactory:'Old' };`;
	const next = updateDefaultFactoryConfig(source, 'defaultPresenterFactory', 'AppPresenter');
	assert.doesNotMatch(next, /\.\.\./);
	assert.match(next, /groupRoutesFunc/);
	assert.equal(updateDefaultFactoryConfig(next, 'defaultPresenterFactory', 'AppPresenter'), next);
	const dynamic = updateDefaultFactoryConfig('export default { ...custom };', 'defaultSchemaFactory', 'Schema');
	assert.match(dynamic, /\.\.\.custom/);
});

test('follows default and renamed barrel exports without changing the imported symbol', async () =>
	fixture(async (root, put) => {
		await put('src/app/public/ui/widgets/card/index.ts', "export { default as Card } from './Component.svelte';");
		await put('src/routes/+page.ts', "import { Card as OrderCard } from '$public/ui/widgets/card'; export { OrderCard };");
		const plan = await planMigration(root);
		const content = plan.writes.get(path.join(root, 'src/routes/+page.ts')).toString();
		assert.match(content, /default as OrderCard/);
		assert.match(content, /Widgets\/Card\/Component.svelte/);
	}));

test('archives all colliding files without picking a winner', async () =>
	fixture(async (root, put) => {
		await put('src/app/shared-kernel/layers/domain/order/model/Order.ts', 'export interface IOtherOrder { name: string }');
		const plan = await planMigration(root);
		const collisions = plan.moves.filter((m) => /model\/Order.ts$/.test(m.from));
		assert.equal(collisions.length, 2);
		assert(collisions.every((m) => m.to.includes('/.backup/')));
		assert(plan.issues.some((i) => i.reason.includes('Target collision')));
	}));

test('refuses a newly occupied target and leaves the legacy tree intact', async () =>
	fixture(async (root, put) => {
		const plan = await planMigration(root);
		await put('src/app/Contexts/Order/Domain/Entities/Order.ts', '// user code');
		await assert.rejects(applyMigration(plan), /already exists|New source file since planning/);
		assert.equal(await fs.readFile(path.join(root, 'src/app/Contexts/Order/Domain/Entities/Order.ts'), 'utf8'), '// user code');
		await fs.access(path.join(root, 'src/app/public'));
	}));

test('normalization preserves getter spread semantics and duplicate keys', () => {
	const source = 'export default { ...{ get name() { return "test" } }, defaultSchemaFactory: "Old" };';
	assert.match(updateDefaultFactoryConfig(source, 'defaultSchemaFactory', 'New'), /\.\.\./);
	const duplicate = 'export default { ...{x: 1}, x: 2 };';
	assert.match(updateDefaultFactoryConfig(duplicate, 'defaultSchemaFactory', 'New'), /\.\.\./);
});

test('preserves Sass partial imports and implicit namespaces after PascalCase renaming', async () =>
	fixture(async (root, put) => {
		await put('src/app/shared-kernel/ui/style/_filters.scss', '$gap: 1px;');
		await put('src/app/public/ui/widgets/card/style.scss', "@use '$shared-kernel/ui/style/filters'; .card { padding: filters.$gap; }");
		const plan = await planMigration(root);
		const style = plan.writes.get(path.join(root, 'src/app/Presentation/Public/Ui/Widgets/Card/Style.scss')).toString();
		assert.match(style, /Filters.scss' as filters/);
		assert(plan.writes.has(path.join(root, 'src/app/Presentation/Shared/Ui/Style/Filters.scss')));
	}));

test('restores originals if an output write fails', async () =>
	fixture(async (root) => {
		const plan = await planMigration(root);
		const original = fs.writeFile;
		let failed = false;
		fs.writeFile = async (file, ...args) => {
			if (!failed && file === path.join(root, 'src/app/Platform/Foundation/DI/ApplicationProvider.ts')) {
				failed = true;
				throw new Error('disk failure');
			}
			return original(file, ...args);
		};
		try {
			await assert.rejects(applyMigration(plan), /rolled back/);
		} finally {
			fs.writeFile = original;
		}
		assert(failed);
		assert.equal(await fs.readFile(path.join(root, 'src/app/public/ui/widgets/card/style.scss'), 'utf8'), '.card { color: red }');
		await assert.rejects(fs.access(path.join(root, 'src/app/Contexts/Order/Domain/Entities/Order.ts')));
	}));

test('merges multiline export barrels as statements, not individual lines', async () =>
	fixture(async (root, put) => {
		await put('src/app/public/layers/domain/order/model/index.ts', "export {\n type IOrder\n} from './Order';");
		await put('src/app/shared-kernel/layers/domain/order/model/Other.ts', 'export interface IOther {}');
		await put('src/app/shared-kernel/layers/domain/order/model/index.ts', "export {\n type IOther\n} from './Other';");
		const plan = await planMigration(root);
		const barrel = plan.writes.get(path.join(root, 'src/app/Contexts/Order/Domain/Entities/index.ts')).toString();
		assert.match(barrel, /IOrder/);
		assert.match(barrel, /IOther/);
		assert.equal(ts.transpileModule(barrel, { reportDiagnostics: true }).diagnostics.length, 0);
	}));
