#!/usr/bin/env node

import { Command } from 'commander';
import {
    initStructure,
    initAliases,
    initMiddleware,
    initEdges,
    initTranslations,
    initSchema,
    initLint,
    initPresenter
} from '../src/commands/init/index.js';
import {
    generateDatasource,
    generateResponse,
    generateRepository,
    generateService,
    generateSchema,
    generatePresenter,
    generateModule,
    generateCrudBase,
    generateCrudPresenter,
    generatePresenterByService,
    generateServiceByRepo
} from '../src/commands/generate/index.js';

const program = new Command();

program
    .name('azure-net')
    .description('Azure-Net CLI generator')
    .version('2.0.0');

// Init commands
program
    .command('init:lint')
    .description('Setup linting and commit tools')
    .action(initLint);

program
    .command('init:structure')
    .description('Generate base folder structure')
    .action(initStructure);

program
    .command('init:aliases')
    .description('Generate alias mappings')
    .action(initAliases);

program
    .command('init:middleware')
    .description('Initialize middleware')
    .action(initMiddleware);

program
    .command('init:edges')
    .description('Initialize edges-svelte')
    .action(initEdges);

program
    .command('init:translations')
    .description('Initialize translations')
    .action(initTranslations);

program
    .command('init:schema')
    .description('Initialize schema factory')
    .action(initSchema);

program
    .command('init:presenter')
    .description('Initialize presenter factory')
    .action(initPresenter);

program
    .command('init')
    .description('Run all initialization steps')
    .action(async () => {
        await initStructure();
        await initAliases();
        // await initEdges();
        // await initMiddleware();
        // await initTranslations();
        // await initSchema();
    });

// Generate commands
program
    .command('make:datasource')
    .description('Generate datasource')
    .action(generateDatasource);

program
    .command('make:response')
    .description('Generate response builder')
    .action(generateResponse);

program
    .command('make:repo')
    .description('Generate repository')
    .action(generateRepository);

program
    .command('make:service')
    .description('Generate service')
    .action(generateService);

program
    .command('make:schema')
    .description('Generate schema')
    .action(generateSchema);

program
    .command('make:presenter')
    .description('Generate presenter')
    .action(generatePresenter);

program
    .command('make:crud-base')
    .description('Generate CRUD repository and service')
    .action(generateCrudBase);

program
    .command('make:crud-presenter')
    .description('Generate CRUD presenter for existing service')
    .action(generateCrudPresenter);

program.parse();