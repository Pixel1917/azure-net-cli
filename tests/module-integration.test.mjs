import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import prompts from 'prompts';
import initStructure from '../src/init/initStructure.js';
import generatePreset from '../src/generate/module/generateModulePreset.js';
import generateRepositoryMethod from '../src/generate/module/generateRepositoryMethod.js';
import generatePresenter from '../src/generate/module/generatePresenter.js';
import createDatasource from '../src/scaffolds/createDatasource.js';
import createResponse from '../src/scaffolds/createResponse.js';
import createSchema from '../src/scaffolds/createCoreSchema.js';
import checkInternal from '../src/checks/checkInternal.js';

const kit = fileURLToPath(new URL('../../azure-net-kit/', import.meta.url));
const available = await fs.access(path.join(kit, 'dist/index.d.ts')).then(
	() => true,
	() => false
);
for (const mode of ['raw', 'simple', 'wrapped'])
	test(`preset + central DI + scoped presenter compiles against built kit (${mode})`, { skip: !available }, async () => {
		const cwd = process.cwd();
		const oldExit = process.exitCode;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-module-'));
		process.chdir(dir);
		const write = async (file, content) => {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, content);
		};
		const run = async (fn, answers) => {
			prompts.inject(answers);
			await fn();
		};
		try {
			await write('azure-net.config.ts', `export default {presentationWorkspaces:['Admin']};`);
			await write('svelte.config.js', `export default {};`);
			await initStructure();
			if (mode !== 'raw') await run(createResponse, ['Api', mode === 'wrapped']);
			await run(createDatasource, ['Api', ...(mode === 'raw' ? [] : ['ApiResponse'])]);
			await run(createSchema, ['Schema', 'en', true]);
			await run(generatePreset, ['__create__', 'Orders', 'Order', '/orders', 'number', 'n']);
			await write(
				'src/app/Platform/Foundation/DI/ApplicationProvider.ts',
				`import { CreateDiContainer } from '@azure-net/kit';
import { ApiDatasource } from '#platform/Foundation/Datasource';
import { OrderRepository } from '#contexts/Orders/Infrastructure/Repositories';
import { OrderUseCases } from '#contexts/Orders/Application/UseCases';
export const ApplicationProvider = CreateDiContainer('ApplicationProvider', {register: () => {
 const datasource = new ApiDatasource({});
 const repository = new OrderRepository(datasource);
 return { Orders: () => new OrderUseCases(repository) };
}});`
			);
			prompts.inject(['', 'Admin', '__create__', 'Checkout', true, true]);
			await generatePresenter({ contextName: 'Orders', useCasesName: 'OrderUseCases' });
			await checkInternal();
			assert.equal(process.exitCode || 0, 0);
			await run(generateRepositoryMethod, ['Orders', 'OrderRepository', 'health', 'get', '/health', true, 'never', false]);
			const contractText = await fs.readFile('src/app/Contexts/Orders/Domain/Ports/OrderRepository.ts', 'utf8');
			assert.match(contractText, /health\(\): Promise<never>/);
			assert.doesNotMatch(contractText, /import type[^\n]*IOrderRepository/);
			const root = path.join(dir, 'src/app');
			const files = ts.sys.readDirectory(root, ['.ts']);
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
					'#contexts/*': [path.join(root, 'Contexts/*')],
					'#platform/*': [path.join(root, 'Platform/*')],
					'#presentation/*': [path.join(root, 'Presentation/*')]
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
			const file = 'src/app/Contexts/Orders/Domain/Ports/OrderRepository.ts';
			const before = await fs.readFile(file, 'utf8');
			await run(generatePreset, ['Orders', 'Order', '/changed', 'string']);
			assert.equal(await fs.readFile(file, 'utf8'), before, 'repeat generation must preserve the repository contract');
		} finally {
			process.chdir(cwd);
			process.exitCode = oldExit;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
