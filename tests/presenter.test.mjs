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

test('presenter uses central DI key, workspace scope, type imports and native helpers', async () => {
	const previous = process.cwd();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-presenter-'));
	const oldExit = process.exitCode;
	process.chdir(dir);
	const write = async (file, content) => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	};
	try {
		await write('src/app/Platform/Foundation/DI/ApplicationProvider.ts', provider);
		await write('src/app/Contexts/Orders/Application/UseCases/OrdersUseCases.ts', useCases);
		await write('src/app/Contexts/Orders/Infrastructure/Repositories/OrdersRepository.ts', repository);
		await write('src/app/Contexts/Orders/Domain/Ports/OrdersRepository.ts', repoInterface);
		await fs.mkdir('src/app/Presentation/Admin/Scopes', { recursive: true });
		prompts.inject(['', 'Admin', '__create__', 'order-checkout', false]);
		await generatePresenter({ contextName: 'Orders', useCasesName: 'OrdersUseCases' });
		assert.equal(process.exitCode, oldExit);
		const generated = await fs.readFile('src/app/Presentation/Admin/Scopes/OrderCheckout/OrdersPresenter.ts', 'utf8');
		assert.match(generated, /const \{ Orders \} = ApplicationProvider\(\)/);
		assert.match(generated, /export class OrdersPresenter/);
		assert.match(generated, /export const useOrdersPresenter = RegisterProvider/);
		assert.match(generated, /constructor\(private readonly useCases: OrdersUseCases\)/);
		assert.doesNotMatch(generated, /createAsyncHelpers|AppPresenter|createPresenterFactory/);
		assert.match(generated, /this\.useCases\.update\(pathParam, request\)/);
		assert.match(generated, /import type \{ IOrder \}/);
		assert.doesNotMatch(generated, /import type[^\n]*(never|Partial|\[\])/);
		assert.match(generated, /createAsyncAction<never>/);
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
