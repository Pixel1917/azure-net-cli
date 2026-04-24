#!/usr/bin/env node

import { Command } from 'commander';
import { addLint } from '../src/plugins/index.js';

const program = new Command();

program.name('azure-net').description('Azure-Net CLI generator').version('2.1.0');

const addCommand = program.command('add').description('Add project integrations and plugins');
const createCommand = program.command('create').description('Create project boilerplate artifacts');
const initCommand = program.command('init').description('Initialize project scaffolding');
const installCommand = program.command('install').description('Install project presets and flows');
const generateCommand = program.command('generate').description('Generate UI artifacts');

addCommand
	.command('commit-tools')
	.description('Setup linting and commit tools')
	.option('-m, --manager <manager>', 'Package manager: bun | pnpm | npm | yarn')
	.action(addLint);

createCommand
	.command('schema-factory')
	.description('Create base schema in src/core/schema')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createCoreSchema.js')).default;
		await handler();
	});

createCommand
	.command('middleware-manager')
	.description('Create middleware manager in src/core/middleware-manager')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createCoreMiddleware.js')).default;
		await handler();
	});

createCommand
	.command('translation-manager')
	.description('Create translation manager in src/core/translation')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createTranslationManager.js')).default;
		await handler();
	});

createCommand
	.command('presenter-factory')
	.description('Create presenter factory in src/core/presenter')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createPresenterFactory.js')).default;
		await handler();
	});

createCommand
	.command('schema-rule')
	.description('Create schema rule in src/core/schema/custom-rules')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createSchemaRule.js')).default;
		await handler();
	});

createCommand
	.command('middleware')
	.description('Create middleware in src/core/middleware-manager/middlewares')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createMiddleware.js')).default;
		await handler();
	});

createCommand
	.command('response')
	.description('Create response in src/core/response')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createResponse.js')).default;
		await handler();
	});

createCommand
	.command('datasource')
	.description('Create datasource in core or context infrastructure')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createDatasource.js')).default;
		await handler();
	});

createCommand
	.command('datasource-provider')
	.description('Create datasource provider in core or context infrastructure')
	.action(async () => {
		const handler = (await import('../src/scaffolds/createDatasourceProvider.js')).default;
		await handler();
	});

const lazyCommand = (command, description, importer) => {
	program
		.command(command)
		.description(description)
		.action(async (...args) => {
			const handler = await importer();
			await handler(...args);
		});
};

initCommand
	.command('edges')
	.description('Initialize edges plugin in vite config')
	.action(async () => {
		const handler = (await import('../src/init/initEdges.js')).default;
		await handler();
	});

initCommand
	.command('folders-structure')
	.description('Generate base folders structure')
	.action(async () => {
		const handler = (await import('../src/init/initStructure.js')).default;
		await handler();
	});

initCommand.action(async () => {
	const initStructure = (await import('../src/init/initStructure.js')).default;
	await initStructure();
});

installCommand
	.command('fresh')
	.description('Run full fresh install flow (structure + optional generators)')
	.action(async () => {
		const handler = (await import('../src/install/installFresh.js')).default;
		await handler();
	});

generateCommand
	.command('component')
	.description('Generate UI component')
	.action(async () => {
		const handler = (await import('../src/generate/ui/generateComponent.js')).default;
		await handler();
	});

generateCommand
	.command('widget')
	.description('Generate UI widget')
	.action(async () => {
		const handler = (await import('../src/generate/ui/generateWidget.js')).default;
		await handler();
	});

generateCommand
	.command('design-component')
	.description('Generate UI design component')
	.action(async () => {
		const handler = (await import('../src/generate/ui/generateDesignComponent.js')).default;
		await handler();
	});

generateCommand
	.command('repository')
	.description('Generate infrastructure repository')
	.action(async () => {
		const handler = (await import('../src/generate/layers/generateRepository.js')).default;
		await handler();
	});

generateCommand
	.command('repo')
	.description('Generate infrastructure repository (module flow)')
	.action(async () => {
		const handler = (await import('../src/generate/module/generateRepository.js')).default;
		await handler();
	});

generateCommand
	.command('repository-method')
	.description('Generate method for an existing repository')
	.action(async () => {
		const handler = (await import('../src/generate/layers/generateRepositoryMethod.js')).default;
		await handler();
	});

generateCommand
	.command('use-cases')
	.description('Generate use-cases for an existing repository')
	.action(async () => {
		const handler = (await import('../src/generate/module/generateUseCases.js')).default;
		await handler();
	});

generateCommand
	.command('domain')
	.description('Generate domain module (model/ports)')
	.action(async () => {
		const handler = (await import('../src/generate/module/generateDomain.js')).default;
		await handler();
	});

generateCommand
	.command('presenter')
	.description('Generate presentation layer presenter from UseCases')
	.action(async () => {
		const handler = (await import('../src/generate/module/generatePresenter.js')).default;
		await handler();
	});

generateCommand
	.command('types-json')
	.description('Fill model interface keys from JSON')
	.action(async () => {
		const handler = (await import('../src/generate/module/generateTypesJson.js')).default;
		await handler();
	});

generateCommand
	.command('schema-from-type')
	.description('Fill schema rules keys from schema generic type')
	.action(async () => {
		const handler = (await import('../src/generate/module/generateSchemaFromType.js')).default;
		await handler();
	});

generateCommand
	.command('module')
	.description('Generate domain + repository + presenter flow')
	.action(async () => {
		const handler = (await import('../src/generate/module/generateModule.js')).default;
		await handler();
	});

lazyCommand('make:repo', 'Generate repository', async () => (await import('../src/commands/generate/generateRepository.js')).default);
lazyCommand('make:service', 'Generate service', async () => (await import('../src/commands/generate/generateService.js')).default);
lazyCommand('make:schema', 'Generate schema', async () => (await import('../src/commands/generate/generateSchema.js')).default);
lazyCommand('make:presenter', 'Generate presenter', async () => (await import('../src/commands/generate/generatePresenter.js')).default);
lazyCommand(
	'make:crud-base',
	'Generate CRUD repository and service',
	async () => (await import('../src/commands/generate/generateCrudBase.js')).default
);
lazyCommand(
	'make:crud-presenter',
	'Generate CRUD presenter for existing service',
	async () => (await import('../src/commands/generate/generateCrudPresenter.js')).default
);
lazyCommand(
	'make:module-base',
	'Generate repository and service for a module',
	async () => (await import('../src/commands/generate/generateModuleBase.js')).default
);
lazyCommand(
	'make:module-presenter',
	'Generate presenter for existing service',
	async () => (await import('../src/commands/generate/generateModulePresenter.js')).default
);
program.parse();
