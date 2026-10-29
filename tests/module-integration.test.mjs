import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import prompts from 'prompts';
import generateFeature from '../src/generate/module/generateFeature.js';
import generateFeaturePreset from '../src/generate/module/generateFeaturePreset.js';
import generateRepositoryMethod from '../src/generate/module/generateRepositoryMethod.js';
import { mergeComposition, wireComposition } from '../src/generate/module/composition.js';
import createDatasource from '../src/scaffolds/createDatasource.js';
import createResponse from '../src/scaffolds/createResponse.js';
import createSchema from '../src/scaffolds/createCoreSchema.js';

const kit = fileURLToPath(new URL('../../azure-net-kit/', import.meta.url));
const available = await fs.access(path.join(kit, 'dist/index.d.ts')).then(
	() => true,
	() => false
);
async function fixture(run) {
	const previous = process.cwd(),
		exit = process.exitCode;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-aggregate-'));
	process.chdir(dir);
	const write = async (file, text) => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
	};
	try {
		await run({ dir, write });
	} finally {
		process.chdir(previous);
		process.exitCode = exit;
		await fs.rm(dir, { recursive: true, force: true });
	}
}
function compile(dir) {
	const files = ts.sys.readDirectory(path.join(dir, 'src'), ['.ts']);
	const program = ts.createProgram(files, {
		noEmit: true,
		strict: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		customConditions: ['svelte'],
		paths: {
			'@azure-net/kit': [path.join(kit, 'dist/index.d.ts')],
			'@azure-net/kit/*': [path.join(kit, 'dist/*')],
			'#contexts/*': [path.join(dir, 'src/app/Contexts/*')],
			'#platform/*': [path.join(dir, 'src/platform/*')],
			'#presentation/*': [path.join(dir, 'src/app/Presentation/*')]
		}
	});
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.equal(
		diagnostics.length,
		0,
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCurrentDirectory: () => dir,
			getCanonicalFileName: (f) => f,
			getNewLine: () => '\n'
		})
	);
}
for (const mode of ['raw', 'simple', 'wrapped'])
	test(`aggregate preset + CompositionRoot + interface presenter typechecks (${mode})`, { skip: !available }, async () => {
		await fixture(async ({ dir, write }) => {
			await write('azure-net.config.ts', `export default {appBoundaries:['Admin']};`);
			if (mode !== 'raw') {
				prompts.inject(['Api', mode === 'wrapped']);
				await createResponse();
			}
			prompts.inject(['Api', ...(mode === 'raw' ? [] : ['ApiResponse']), true]);
			await createDatasource();
			prompts.inject(['Schema', 'en', true]);
			await createSchema();
			await generateFeaturePreset({
				context: 'Orders',
				aggregate: 'Order',
				datasource: 'ApiDatasource',
				composition: true,
				boundary: 'Admin',
				scope: 'Checkout',
				schemas: true,
				idType: 'number'
			});
			assert.equal(process.exitCode || 0, 0);
			const aggregate = 'src/app/Contexts/Orders/Order';
			const repository = await fs.readFile(aggregate + '/Infrastructure/Repositories/OrderRepository.ts', 'utf8');
			assert.match(repository, /import type \{ IApiDatasource \}/);
			const usecases = await fs.readFile(aggregate + '/Application/UseCases/OrderUseCases.ts', 'utf8');
			assert.match(usecases, /export interface IOrderUseCases/);
			const presenter = await fs.readFile('src/app/Presentation/Admin/Scopes/Checkout/OrderPresenter.ts', 'utf8');
			assert.match(presenter, /useCases: IOrderUseCases/);
			const binding = await fs.readFile('src/app/Presentation/Admin/Scopes/Checkout/index.ts', 'utf8');
			assert.match(binding, /resolve\(\)\.OrderUseCases/);
			assert.doesNotMatch(presenter, /RegisterProvider|CompositionRoot|ApplicationProvider/);
			assert.equal(
				await fs.access(aggregate + '/Application/UseCases/index.ts').then(
					() => true,
					() => false
				),
				false
			);
			compile(dir);
			prompts.inject(['Orders', 'Order', 'OrderRepository', 'health', 'get', '/health', true, 'never', false]);
			await generateRepositoryMethod();
			assert.match(await fs.readFile(aggregate + '/Domain/Ports/OrderRepository.ts', 'utf8'), /health\(\): Promise<never>/);
			assert.match(await fs.readFile(aggregate + '/Application/UseCases/OrderUseCases.ts', 'utf8'), /health: IOrderRepository\['health'\]/);
			compile(dir);
			await generateFeature({
				context: 'Orders',
				aggregate: 'Shipment',
				datasource: 'ApiDatasource',
				composition: true,
				boundary: 'Admin',
				scope: 'Checkout',
				presenter: true
			});
			compile(dir);
			const composition = await fs.readFile('src/app/Contexts/Orders/Composition.ts', 'utf8');
			assert.match(composition, /OrderUseCases:/);
			assert.match(composition, /ShipmentUseCases:/);
			await wireComposition({ context: 'Orders', aggregate: 'Order', repository: 'OrderRepository', datasource: 'ApiDatasource' });
			assert.equal(await fs.readFile('src/app/Contexts/Orders/Composition.ts', 'utf8'), composition);
			await assert.rejects(
				() => generateFeaturePreset({ context: 'Orders', aggregate: 'Order', datasource: 'ApiDatasource', composition: true }),
				/overwrite/
			);
			assert.equal(await fs.readFile('src/app/Contexts/Orders/Composition.ts', 'utf8'), composition);
		});
	});

const input = { context: 'Orders', aggregate: 'Order', repository: 'OrderRepository', datasource: 'ApiDatasource' };
test('composition merge preserves source, custom registrations, comments and rejects ambiguous AST', () => {
	const original = `import { CompositionRoot } from '@azure-net/kit';
export const OrdersContext = new CompositionRoot({
 dependsOn: { Other },
 register: ({ Other }) => {
  const keep = Other;
  return {
   // preserve my registration
   Custom: () => keep,
  };
 }
});`;
	const merged = mergeComposition(original, input);
	assert.match(merged, /preserve my registration/);
	assert.match(merged, /Custom: \(\) => keep/);
	assert.match(merged, /HttpProvider/);
	assert.equal(ts.transpileModule(merged, { reportDiagnostics: true }).diagnostics.length, 0);
	for (const source of [
		original.replace('return {', 'return condition ? {').replace('};', '} : {};'),
		original.replace('Custom: () => keep,', '...services,'),
		original.replace('dependsOn: { Other }', 'dependsOn: getDependencies()'),
		original.replace('Custom: () => keep,', 'OrderUseCases: () => custom(),'),
		original.replace('dependsOn: { Other }', 'dependsOn: { Other, HttpProvider: Another }')
	])
		assert.throws(() => mergeComposition(source, input));
	assert.equal(mergeComposition(merged, input), merged);
});

test('declarative spec supports custom routes and method DTOs; invalid spec does not write sources', async () => {
	await fixture(async ({ write }) => {
		prompts.inject(['Api', true]);
		await createDatasource();
		await write(
			'feature.json',
			JSON.stringify({
				context: 'Identity',
				aggregate: 'Auth',
				datasource: 'ApiDatasource',
				composition: false,
				presenter: false,
				types: [
					{ name: 'ILoginResource', layer: 'Resources', fields: { token: 'string' } },
					{ name: 'ILoginCommand', layer: 'DTO', fields: { email: 'string', password: 'string' } }
				],
				methods: [{ name: 'login', httpMethod: 'post', route: '/auth/login', response: 'ILoginResource', body: 'ILoginCommand' }]
			})
		);
		await generateFeature({ spec: 'feature.json' });
		const code = await fs.readFile('src/app/Contexts/Identity/Auth/Infrastructure/Repositories/AuthRepository.ts', 'utf8');
		assert.match(code, /login\(request: ILoginCommand\)/);
		assert.match(code, /http.post\(`\/auth\/login`/);
		await assert.rejects(
			() =>
				generateFeature({
					context: 'Bad',
					aggregate: 'Bad',
					datasource: 'ApiDatasource',
					composition: false,
					presenter: false,
					methods: [{ name: 'constructor', httpMethod: 'get', route: '/x', response: 'string' }]
				}),
			/method/
		);
		assert.equal(
			await fs.access('src/app/Contexts/Bad').then(
				() => true,
				() => false
			),
			false
		);
	});
});

test('feature supports simultaneous query/body and cross-referenced DTO fields with strict checking', { skip: !available }, async () => {
	await fixture(async ({ dir, write }) => {
		prompts.inject(['Api', true]);
		await createDatasource();
		await generateFeature({
			context: 'Identity',
			aggregate: 'Login',
			datasource: 'ApiDatasource',
			composition: true,
			boundary: 'Public',
			scope: 'Identity',
			types: [
				{ name: 'ILoginResource', layer: 'Resources', fields: { token: 'string', profile: 'IProfileResource' } },
				{ name: 'IProfileResource', layer: 'Resources', fields: { id: 'number' } },
				{ name: 'ILoginCommand', layer: 'DTO', fields: { username: 'string' } },
				{ name: 'ILoginQuery', layer: 'DTO', fields: { 'remember?': 'boolean' } }
			],
			methods: [
				{ name: 'login', httpMethod: 'post', route: '/auth/login', response: 'ILoginResource', query: 'ILoginQuery', body: 'ILoginCommand' }
			]
		});
		const repository = await fs.readFile('src/app/Contexts/Identity/Login/Infrastructure/Repositories/LoginRepository.ts', 'utf8');
		assert.match(repository, /login\(queryParams: ILoginQuery, request: ILoginCommand\)/);
		assert.match(repository, /query.toSearchParams\(queryParams\), json: request/);
		compile(dir);
	});
});

test('malformed spec is rejected before creating aggregate files', async () => {
	await fixture(async () => {
		prompts.inject(['Api', true]);
		await createDatasource();
		for (const invalid of [
			{ idType: 'uuid' },
			{ methods: [{ name: 'get', httpMethod: 'get', route: '/x' }] },
			{ methods: [{ name: 'get', httpMethod: 'get', route: '/x', response: 'string; console.log(1)' }] },
			{ types: [{ name: 'IBad', layer: 'Enums', fields: {} }] },
			{ types: [{ name: 'IBadResource', layer: 'Resources', fields: { x: 42 } }] },
			{ types: [{ name: 'IBadResource', layer: 'Resources', fields: { x: 'IUnspecified' } }] },
			{ types: {} },
			{ composition: 'yes' },
			{ methods: [{ name: 'get', httpMethod: 'get', route: '/x', response: 'IBadResource', body: 'IBadCommand' }] }
		]) {
			await assert.rejects(() =>
				generateFeature({
					context: 'Invalid',
					aggregate: 'Bad',
					datasource: 'ApiDatasource',
					composition: false,
					presenter: false,
					...invalid
				})
			);
			assert.equal(
				await fs.access('src/app/Contexts/Invalid').then(
					() => true,
					() => false
				),
				false
			);
		}
	});
});

test('interactive aggregate pipeline selects an aggregate and produces compilable classes', { skip: !available }, async () => {
	await fixture(async ({ dir, write }) => {
		await write('azure-net.config.ts', "export default {appBoundaries:['Public']};");
		await fs.mkdir('src/app/Presentation/Public/Scopes', { recursive: true });
		prompts.inject(['Api', true]);
		await createDatasource();
		const { default: generateModule } = await import('../src/generate/module/generateModule.js');
		prompts.inject([
			'__create__',
			'Identity',
			'__create__',
			'Auth',
			true,
			'IAuthResource',
			true,
			'ILoginCommand',
			'Auth',
			{ name: 'ApiDatasource', importPath: '#platform/Foundation/Datasource' },
			1,
			'login',
			'post',
			'/auth/login',
			false,
			{ name: 'IAuthResource', layer: 'Resources' },
			true,
			{ name: 'ILoginCommand', layer: 'DTO' },
			true,
			true,
			'',
			'Public',
			'__create__',
			'Identity',
			false
		]);
		await generateModule();
		assert.equal(process.exitCode || 0, 0);
		compile(dir);
	});
});

test('manual composition pauses generation before any presenter is created', async () => {
	await fixture(async () => {
		prompts.inject(['Api', true]);
		await createDatasource();
		prompts.inject([false, false]);
		await generateFeature({ context: 'Catalog', aggregate: 'Product', datasource: 'ApiDatasource', boundary: 'Public', scope: 'Catalog' });
		assert.equal(
			await fs.access('src/app/Contexts/Catalog/Composition.ts').then(
				() => true,
				() => false
			),
			false
		);
		assert.equal(
			await fs.access('src/app/Presentation/Public/Scopes/Catalog/ProductPresenter.ts').then(
				() => true,
				() => false
			),
			false
		);
		assert.equal(
			await fs.access('src/app/Contexts/Catalog/Product/Infrastructure/Repositories/ProductRepository.ts').then(
				() => true,
				() => false
			),
			true
		);
	});
});

test('explicit datasource and HttpProvider registrations are validated', async () => {
	await fixture(async ({ write }) => {
		await assert.rejects(
			() =>
				generateFeature({ context: 'Orders', aggregate: 'Order', datasource: 'MissingDatasource', composition: false, presenter: false }),
			/Datasource file not found/
		);
		await write('src/platform/Foundation/Datasource/BrokenDatasource.ts', 'export class BrokenDatasource {}');
		await assert.rejects(
			() =>
				generateFeature({ context: 'Orders', aggregate: 'Order', datasource: 'BrokenDatasource', composition: false, presenter: false }),
			/interface IBrokenDatasource/
		);
		prompts.inject(['Api', true]);
		await createDatasource();
		const provider = 'src/platform/Foundation/Provider/HttpProvider.ts';
		const text = await fs.readFile(provider, 'utf8');
		await fs.writeFile(provider, text.replace('ApiDatasource: ()', 'OtherDatasource: ()'));
		await assert.rejects(
			() => wireComposition({ context: 'Orders', aggregate: 'Order', repository: 'OrderRepository', datasource: 'ApiDatasource' }),
			/does not statically register/
		);
		assert.equal(
			await fs.access('src/app/Contexts/Orders/Composition.ts').then(
				() => true,
				() => false
			),
			false
		);
	});
});
