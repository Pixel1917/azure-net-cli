#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import commit from '../src/git/commit.js';
import push from '../src/git/push.js';
import { addLint } from '../src/plugins/index.js';
const program = new Command();
program
    .name('azure-net')
    .description('Azure-Net CLI generator')
    .version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
program
    .command('commit')
    .description('Interactively commit staged changes')
    .action(() => commit());
program
    .command('push')
    .description('Check, stage, commit and push')
    .option('--no-check', 'Skip all project checks')
    .action((options) => push(options));
program
    .command('migrate')
    .description('Migrate the legacy application tree with backups and a report')
    .option('--dry-run', 'Show the plan without writing files')
    .option('-y, --yes', 'Apply the migration without confirmation')
    .action(async (options) => {
    await (await import('../src/migrate/migrate.js')).default(options);
});
const addCommand = program.command('add').description('Add project integrations and plugins');
const createCommand = program.command('create').description('Create project boilerplate artifacts');
const initCommand = program.command('init').description('Initialize project scaffolding');
const installCommand = program.command('install').description('Install project presets and flows');
const generateCommand = program.command('generate').description('Generate UI artifacts');
const checkCommand = program.command('check').description('Run project checks');
addCommand.command('commit-tools').description('Replace Prettier configuration without installing packages').action(addLint);
createCommand
    .command('schema-factory')
    .description('Create base schema in Platform/Foundation')
    .action(async () => {
    const handler = (await import('../src/scaffolds/createCoreSchema.js')).default;
    await handler();
});
createCommand
    .command('translation-manager')
    .description('Create translation manager in Platform/Bootstrap/Localization')
    .action(async () => {
    const handler = (await import('../src/scaffolds/createTranslationManager.js')).default;
    await handler();
});
createCommand
    .command('schema-rule')
    .description('Create schema rule in Platform/Foundation')
    .action(async () => {
    const handler = (await import('../src/scaffolds/createSchemaRule.js')).default;
    await handler();
});
createCommand
    .command('response')
    .description('Create response in Platform/Foundation')
    .action(async () => {
    const handler = (await import('../src/scaffolds/createResponse.js')).default;
    await handler();
});
createCommand
    .command('datasource')
    .description('Create datasource in Platform/Foundation')
    .action(async () => {
    const handler = (await import('../src/scaffolds/createDatasource.js')).default;
    await handler();
});
initCommand
    .command('edges')
    .description('Configure AzureNetPlugin in Vite (legacy command name)')
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
    .description('Generate domain types (Entities/Ports)')
    .action(async () => {
    const handler = (await import('../src/generate/module/generateDomain.js')).default;
    await handler();
});
generateCommand
    .command('store')
    .description('Generate a request-isolated reactive class with a browser singleton')
    .action(async () => {
    const handler = (await import('../src/generate/module/generateStore.js')).default;
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
generateCommand
    .command('module-preset')
    .description('Generate preset CRUD-like module flow')
    .action(async () => {
    const handler = (await import('../src/generate/module/generateModulePreset.js')).default;
    await handler();
});
generateCommand
    .command('routes')
    .description('Generate typed SvelteKit routes list')
    .action(async () => {
    const handler = (await import('../src/generate/routes/generateRoutes.js')).default;
    await handler();
});
checkCommand
    .command('presenter-names')
    .description('Check duplicate presenter names in src')
    .action(async () => {
    const handler = (await import('../src/checks/checkPresenterNames.js')).default;
    await handler();
});
checkCommand
    .command('provider-names')
    .description('Check duplicate provider names in src')
    .action(async () => {
    const handler = (await import('../src/checks/checkProviderNames.js')).default;
    await handler();
});
checkCommand
    .command('provider-graph')
    .description('Check provider dependency graph for cycles')
    .action(async () => {
    const handler = (await import('../src/checks/checkProviderGraph.js')).default;
    await handler();
});
checkCommand
    .command('domain')
    .description('Check domain naming and structure rules in all contexts')
    .action(async () => {
    const handler = (await import('../src/checks/checkDomain.js')).default;
    await handler();
});
checkCommand
    .command('imports')
    .description('Check import extensions and import group order in src')
    .action(async () => {
    const handler = (await import('../src/checks/checkImports.js')).default;
    await handler();
});
checkCommand
    .command('hooks')
    .description('Check that manual SvelteKit hooks are not present')
    .action(async () => {
    const handler = (await import('../src/checks/checkHooks.js')).default;
    await handler();
});
checkCommand
    .command('layer-imports')
    .description('Check forbidden imports between layers inside each context')
    .action(async () => {
    const handler = (await import('../src/checks/checkLayerImports.js')).default;
    await handler();
});
checkCommand
    .command('layer-boundaries')
    .description('Check layer boundaries between contexts by aliases')
    .action(async () => {
    const handler = (await import('../src/checks/checkLayerBoundaries.js')).default;
    await handler();
});
checkCommand
    .command('folders-structure')
    .description('Check allowed folders structure in context layers/ui/components')
    .action(async () => {
    const handler = (await import('../src/checks/checkFoldersStructure.js')).default;
    await handler();
});
checkCommand
    .command('internal')
    .description('Run all internal azure-net checks')
    .action(async () => {
    const handler = (await import('../src/checks/checkInternal.js')).default;
    await handler();
});
checkCommand
    .command('project')
    .description('Run full project checks: format, internal, lint, typecheck')
    .action(async () => {
    const handler = (await import('../src/checks/checkProject.js')).default;
    await handler();
});
program.parseAsync().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
