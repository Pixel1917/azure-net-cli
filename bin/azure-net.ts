#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import commit from '../src/git/commit.js';
import push from '../src/git/push.js';

const program = new Command()
	.name('azure-net')
	.description('Azure-Net architecture tooling')
	.version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
const handler = (file: string) => async () => {
	await (await import(`../src/${file}.js`)).default();
};
program
	.command('commit')
	.description('Interactively commit staged changes')
	.action(() => commit());
program
	.command('push')
	.description('Check, stage, commit and push')
	.option('--no-check', 'Skip project checks')
	.action((options) => push(options));
program
	.command('prettier-config')
	.description('Install recommended Prettier configuration, without packages')
	.action(handler('plugins/prettierConfig'));
program
	.command('folders-update')
	.description('Add missing architecture folders and configured app boundaries')
	.action(handler('init/initStructure'));
const hooks = program.command('git-hooks').description('Manage the Azure-Net pre-commit check');
hooks.command('add').action(async () => {
	await (await import('../src/git/hooks.js')).addGitHooks();
});
hooks.command('remove').action(async () => {
	await (await import('../src/git/hooks.js')).removeGitHooks();
});
program
	.command('migrate')
	.description('Plan/migrate legacy architecture with backups and a report')
	.option('--dry-run', 'Only show the migration plan')
	.option('-y, --yes', 'Apply without confirmation')
	.action(async (options) => {
		await (await import('../src/migrate/migrate.js')).default(options);
	});
program
	.command('install')
	.command('fresh')
	.description('Configure a new application interactively')
	.action(handler('install/installFresh'));
const foundation = program.command('foundation').description('Generate src/platform/Foundation artifacts');
for (const [name, file] of Object.entries({
	schema: 'createCoreSchema',
	'schema-rule': 'createSchemaRule',
	response: 'createResponse',
	datasource: 'createDatasource',
	'cookie-instance': 'createCookieInstance'
}))
	foundation.command(name).action(handler(`scaffolds/${file}`));
const bootstrap = program.command('bootstrap').description('Generate src/platform/Bootstrap artifacts');
for (const [name, file] of Object.entries({
	translations: 'createTranslationManager',
	middleware: 'createMiddleware',
	'error-handler': 'createErrorHandler'
}))
	bootstrap.command(name).action(handler(`scaffolds/${file}`));
const generate = program.command('generate').description('Generate aggregate and presentation code');
const component = generate.command('component').description('Generate a Core, Page, Scopes or Composite component');
component.action(handler('generate/ui/generateComponent'));
for (const kind of ['core', 'page', 'scopes', 'composition'] as const)
	component.command(kind).action(async () => {
		await (await import('../src/generate/ui/generateComponent.js')).default(kind);
	});
for (const [name, file] of Object.entries({
	repository: 'generate/module/generateRepository',
	'repository-method': 'generate/module/generateRepositoryMethod',
	'use-cases': 'generate/module/generateUseCases',
	domain: 'generate/module/generateDomain',
	store: 'generate/module/generateStore',
	presenter: 'generate/module/generatePresenter',
	'types-json': 'generate/module/generateTypesJson',
	'schema-from-type': 'generate/module/generateSchemaFromType',
	aggregate: 'generate/module/generateModule',
	'aggregate-preset': 'generate/module/generateModulePreset',
	routes: 'generate/routes/generateRoutes'
}))
	generate.command(name).action(handler(file));
for (const name of ['feature', 'feature-preset']) {
	generate
		.command(name)
		.description('Generate from a compact spec or flags (feature-preset defaults to CRUD)')
		.option('--spec <file>', 'JSON feature description')
		.option('--context <name>')
		.option('--aggregate <name>')
		.option('--name <name>')
		.option('--route <path>')
		.option('--datasource <name>')
		.option('--boundary <name>')
		.option('--scope <name>')
		.option('--methods <json>', 'JSON array of method descriptions')
		.option('--id-type <type>', 'string or number')
		.option('--auto-compose', 'Update Composition.ts without an interactive confirmation')
		.option('--no-composition', 'Print manual wiring instructions instead')
		.option('--no-presenter', 'Generate domain/application/infrastructure only')
		.option('--schemas', 'Generate presenter schemas')
		.action(async (options, command: Command) => {
			const explicit = Object.fromEntries(Object.entries(options).filter(([key]) => command.getOptionValueSource(key) === 'cli'));
			if (explicit.autoCompose && explicit.composition === false) throw new Error('Choose either --auto-compose or --no-composition.');
			if (explicit.autoCompose) explicit.composition = true;
			delete explicit.autoCompose;
			await (await import('../src/generate/module/generateFeature.js')).generateFeature(explicit, name === 'feature-preset');
		});
}
const check = program.command('check').description('Validate architecture and project quality');
for (const [name, file] of Object.entries({
	'presenter-names': 'checkPresenterNames',
	'provider-names': 'checkProviderNames',
	'provider-graph': 'checkProviderGraph',
	domain: 'checkDomain',
	imports: 'checkImports',
	hooks: 'checkHooks',
	'layer-imports': 'checkLayerImports',
	'layer-boundaries': 'checkLayerBoundaries',
	'folders-structure': 'checkFoldersStructure',
	internal: 'checkInternal',
	project: 'checkProject'
}))
	check.command(name).action(handler(`checks/${file}`));

program.parseAsync().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
