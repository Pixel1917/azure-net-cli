import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import prompts from 'prompts';
import generatePresenter, {
	parseProviderInfo,
	parseUseCasesInfo,
	parseRepositoryInterfaceMethods,
	parseRepositoryHttpMethods,
	normalizeTypeImports
} from '../src/generate/module/generatePresenter.js';

const provider = `import { OrdersUseCases as OrderService } from '#contexts/Orders/Application/UseCases';
export const ApplicationProvider = CreateDiContainer('ApplicationProvider', {
 register: () => {
  const datasource = new ApiDatasource();
  const repository = new OrdersRepository(datasource);
  return { Orders: () => new OrderService(repository) };
 }
});`;
const useCases = `import { ClassMirror } from '@azure-net/kit';
import type { IOrdersRepository, IOrder } from '#contexts/Orders/Domain';
export class OrdersUseCases extends ClassMirror {
 constructor(private repository: IOrdersRepository) {super(repository);}
 declare resource: IOrdersRepository['resource'];
 declare update: IOrdersRepository['update'];
 declare destroy: IOrdersRepository['destroy'];
}`;
const repoInterface = `import type { IOrder } from '../Entities';
export interface IOrdersRepository {
 resource(pathParam: number): Promise<IOrder[]>;
 update(pathParam: number, request: Partial<IOrder>): Promise<IOrder>;
 destroy(pathParam: number): Promise<never>;
}`;
const repository = `export class OrdersRepository implements IOrdersRepository {
 async resource(pathParam: number) {return this.datasource.createRequest(({http}) => http.get('/orders'));}
 async update(pathParam: number, request: Partial<IOrder>) {return this.datasource.createRequest(({http}) => http.put('/orders'));}
 async destroy(pathParam: number) {return this.datasource.createRequest(({http}) => http.delete('/orders'));}
}`;

test('provider parser understands block register, service names and import aliases', () => {
	assert.deepEqual([...parseProviderInfo(provider).services], [['Orders', 'OrdersUseCases']]);
	assert.deepEqual(parseUseCasesInfo(useCases).methods, ['resource', 'update', 'destroy']);
	assert.equal(parseUseCasesInfo(useCases).repositoryInterfaceName, 'IOrdersRepository');
	assert.deepEqual(
		[...parseRepositoryHttpMethods(repository)],
		[
			['resource', 'get'],
			['update', 'put'],
			['destroy', 'delete']
		]
	);
	const methods = parseRepositoryInterfaceMethods(repoInterface, 'IOrdersRepository');
	assert.equal(methods[0].responseType, 'IOrder[]');
	assert.equal(methods[1].params[1].type, 'Partial<IOrder>');
	assert.deepEqual(normalizeTypeImports(['never', 'IOrder[]', 'Partial<IOrder>', 'Record<string, TOrder>']), ['IOrder', 'TOrder']);
});

test('presenter class uses usecase interface; scope index binds the context', async () => {
	const previous = process.cwd();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-presenter-'));
	const oldExit = process.exitCode;
	process.chdir(dir);
	const write = async (file, content) => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	};
	try {
		await write('src/app/Contexts/Orders/Composition.ts', provider);
		await write('src/app/Contexts/Orders/Order/Application/UseCases/OrdersUseCases.ts', useCases);
		await write('src/app/Contexts/Orders/Order/Infrastructure/Repositories/OrdersRepository.ts', repository);
		await write('src/app/Contexts/Orders/Order/Domain/Ports/OrdersRepository.ts', repoInterface);
		await fs.mkdir('src/app/Presentation/Admin/Scopes', { recursive: true });
		prompts.inject(['', 'Admin', '__create__', 'order-checkout', false]);
		await generatePresenter({ contextName: 'Orders', aggregateName: 'Order', useCasesName: 'OrdersUseCases' });
		assert.equal(process.exitCode, oldExit);
		const generated = await fs.readFile('src/app/Presentation/Admin/Scopes/OrderCheckout/OrdersPresenter.ts', 'utf8');
		const index = await fs.readFile('src/app/Presentation/Admin/Scopes/OrderCheckout/index.ts', 'utf8');
		assert.match(index, /resolve\(\)\.Orders/);
		assert.match(generated, /export class OrdersPresenter/);
		assert.match(index, /export const useOrdersPresenter = RegisterOrdersPresenter/);
		assert.match(generated, /constructor\(private readonly useCases: IOrdersUseCases\)/);
		assert.doesNotMatch(generated, /createAsyncHelpers|AppPresenter|createPresenterFactory/);
		assert.match(generated, /this\.useCases\.update\(pathParam, request\)/);
		assert.match(generated, /import type \{ IOrder \}/);
		assert.doesNotMatch(generated, /import type[^\n]*(never|Partial|\[\])/);
		assert.match(generated, /createAsyncAction\(\(\) => this.useCases.destroy/);
		assert.equal(
			ts.transpileModule(generated, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext } }).diagnostics.length,
			0
		);
	} finally {
		process.chdir(previous);
		process.exitCode = oldExit;
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('store generation puts class and request-safe singleton binding in scope Stores, without overwriting', async () => {
	const cwd = process.cwd(),
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-store-'));
	process.chdir(dir);
	try {
		await fs.mkdir('src/app/Presentation/Public/Scopes', { recursive: true });
		const { default: generateStore } = await import('../src/generate/module/generateStore.js');
		prompts.inject(['Public', '__create__', 'Identity', 'AccountStore']);
		await generateStore();
		const store = 'src/app/Presentation/Public/Scopes/Identity/Stores/AccountStore.svelte.ts';
		const index = 'src/app/Presentation/Public/Scopes/Identity/Stores/index.ts';
		assert.match(await fs.readFile(store, 'utf8'), /value = \$state<string \| null>/);
		const before = await fs.readFile(index, 'utf8');
		assert.match(before, /lifecycle: 'singleton'/);
		assert.doesNotMatch(await fs.readFile(store, 'utf8'), /RegisterProvider/);
		prompts.inject(['Public', 'Identity', 'AccountStore']);
		await generateStore();
		assert.equal(await fs.readFile(index, 'utf8'), before);
	} finally {
		process.chdir(cwd);
		await fs.rm(dir, { recursive: true, force: true });
	}
});
