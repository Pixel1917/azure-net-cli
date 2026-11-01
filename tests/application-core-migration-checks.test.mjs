import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planMigration, applyMigration } from '../src/migrate/migrate.js';
import checkBoundaries from '../src/checks/checkLayerBoundaries.js';
import { importResolver } from '../src/checks/architecture.js';

test('Schema, bootstrap entry and uniquely referenced responses map to their canonical owners', () =>
	fixture(
		{
			'src/platform/Foundation/Schema/Schema.ts': 'export const Schema = {};',
			'src/platform/Bootstrap/Bootstrap.ts': 'export const Bootstrap = {};',
			'src/platform/Foundation/Datasource/ApiDatasource.ts':
				"import { ApiResponse } from '../Response/ApiResponse'; export class ApiDatasource {}",
			'src/platform/Foundation/Datasource/OtherDatasource.ts':
				"import { OtherResponse } from '../Response/OtherResponse'; export class OtherDatasource {}",
			'src/platform/Foundation/Response/ApiResponse.ts': 'export class ApiResponse {}',
			'src/platform/Foundation/Response/OtherResponse.ts': 'export class OtherResponse {}',
			'src/program.ts': "import { Bootstrap } from './platform/Bootstrap/Bootstrap'; export { Bootstrap };"
		},
		async (root) => {
			const plan = await planMigration(root);
			for (const file of ['Validation/Schema.ts', 'Http/ApiDatasource/ApiResponse.ts', 'Http/OtherDatasource/OtherResponse.ts'])
				assert.ok(plan.writes.has(path.join(root, 'src/app/ApplicationCore', file)), file);
			assert.ok(plan.writes.has(path.join(root, 'src/bootstrap/index.ts')));
			assert.match(plan.writes.get(path.join(root, 'src/program.ts')).toString(), /from "#bootstrap"/);
			assert.equal(plan.issues.length, 0);
			await applyMigration(plan);
			await assert.rejects(planMigration(root), /Nothing to migrate/);
		}
	));

async function fixture(input, run) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'application-core-')));
	try {
		for (const [file, content] of Object.entries({ 'azure-net.config.ts': 'export default {};', 'package.json': '{}', ...input })) {
			await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
			await fs.writeFile(path.join(root, file), content);
		}
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

for (const base of ['src/platform', 'src/app/Platform', 'src/app/shared/essentials']) {
	test(`migration groups HTTP and separates bootstrap from ${base}`, () => {
		const legacy = base.endsWith('essentials');
		const foundation = `${base}/${legacy ? 'foundation' : 'Foundation'}`;
		const runtime = legacy ? 'src/app/shared/runtime/bootstrap' : `${base}/Bootstrap`;
		return fixture(
			{
				[`${foundation}/Datasource/ApiDatasource.ts`]: 'export class ApiDatasource {}',
				[`${foundation}/Response/ApiResponse.ts`]: 'export class ApiResponse {}',
				[`${foundation}/Provider/HttpProvider.ts`]:
					"import { ApiDatasource } from '../Datasource/ApiDatasource'; export const HttpProvider = new ApiDatasource();",
				[`${foundation}/Config/AppConfig.ts`]: 'export const AppConfig = {};',
				[`${runtime}/Logs/index.ts`]: 'export const logs = {};',
				'src/program.ts': `import { logs } from './${path.relative('src', runtime)}/Logs'; export { logs };`,
				'src/routes/page.ts': `import { HttpProvider } from '../${path.relative('src', foundation)}/Provider/HttpProvider'; export { HttpProvider };`
			},
			async (root) => {
				const plan = await planMigration(root);
				for (const file of [
					'Http/ApiDatasource/Datasource.ts',
					'Http/ApiDatasource/ApiResponse.ts',
					'Http/ApiDatasource/HttpProvider.ts',
					'Configuration/AppConfig.ts'
				])
					assert.ok(plan.writes.has(path.join(root, 'src/app/ApplicationCore', file)), file);
				assert.ok(plan.writes.has(path.join(root, 'src/bootstrap/Logs/index.ts')));
				assert.match(
					plan.writes.get(path.join(root, 'src/routes/page.ts')).toString(),
					/#applicationCore\/Http\/ApiDatasource\/HttpProvider/
				);
				assert.match(plan.writes.get(path.join(root, 'src/program.ts')).toString(), /#bootstrap\/Logs/);
				assert.equal(plan.issues.length, 0);
				await applyMigration(plan);
				await assert.rejects(planMigration(root), /Nothing to migrate/);
			}
		);
	});
}

test('ambiguous HTTP and existing target collisions preserve live source and archive bytes', () =>
	fixture(
		{
			'src/platform/Foundation/Datasource/ApiDatasource.ts': 'export class ApiDatasource {}',
			'src/platform/Foundation/Datasource/OtherDatasource.ts': 'export class OtherDatasource {}',
			'src/platform/Foundation/Response/Result.ts': 'export class Result {}',
			'src/platform/Foundation/Config/AppConfig.ts': 'export const AppConfig = 1;',
			'src/app/ApplicationCore/Configuration/AppConfig.ts': 'export const AppConfig = 2;'
		},
		async (root) => {
			const plan = await planMigration(root);
			for (const file of ['Response/Result.ts', 'Config/AppConfig.ts']) {
				assert.ok(!plan.removes.includes(path.join(root, 'src/platform/Foundation', file)));
				assert.ok(plan.writes.has(path.join(root, 'src/app/.backup/_project/src/platform/Foundation', file)));
			}
			assert.ok(!plan.writes.has(path.join(root, 'src/app/ApplicationCore/Configuration/AppConfig.ts')));
		}
	));

test('current ApplicationCore layout stays untouched', () =>
	fixture(
		{
			'src/app/ApplicationCore/Http/ApiDatasource/Datasource.ts': 'export class ApiDatasource {}',
			'src/bootstrap/Logs/index.ts': 'export const logs = {};'
		},
		async (root) => {
			await assert.rejects(planMigration(root), /Nothing to migrate/);
		}
	));

test('dependency checks enforce core isolation and bootstrap callers across all src', async () => {
	const cases = [
		['app/ApplicationCore/Services/Test.ts', '#contexts/Orders/Composition', false],
		['app/ApplicationCore/Services/Test.ts', '#presentation/Public/Scopes/Test', false],
		['app/ApplicationCore/Services/Test.ts', '../../Contexts/Orders/Composition', false],
		['app/Contexts/Orders/Composition.ts', '#bootstrap/Logs', false],
		['app/Presentation/Public/Scopes/Test.ts', '#bootstrap', false],
		['lib/Test.ts', '../bootstrap/Logs', false],
		['other/Test.ts', '#bootstrap/Logs', false],
		['program.js', '#bootstrap/Logs', false],
		['routes/page.ts', '#bootstrap/Logs', true],
		['program.ts', '#bootstrap/Logs', true],
		['bootstrap/Logs/index.ts', '#bootstrap/Pipelines', true],
		['app/Contexts/Orders/Composition.ts', '#applicationCore/Services/Test', true],
		['lib/Test.ts', '#applicationCore/Services/Test', true]
	];
	for (const [file, target, allowed] of cases)
		await fixture({ [`src/${file}`]: `export * from '${target}';` }, async (root) => {
			const previous = process.cwd();
			const log = console.log,
				error = console.error,
				exitCode = process.exitCode;
			try {
				process.chdir(root);
				console.log = console.error = () => {};
				process.exitCode = 0;
				await checkBoundaries();
				assert.equal(process.exitCode, allowed ? 0 : 1, `${file} -> ${target}`);
				const resolve = await importResolver();
				assert.equal(resolve(path.join(root, 'src/program.ts'), '#program'), path.join(root, 'src/program.ts'));
			} finally {
				process.chdir(previous);
				console.log = log;
				console.error = error;
				process.exitCode = exitCode;
			}
		});
});
