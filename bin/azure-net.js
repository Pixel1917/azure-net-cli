#!/usr/bin/env node

import { Command } from 'commander';
import generateRequest from '../src/commands/generateRequest.js';
import generateDatasource from '../src/commands/generateDatasource.js';
import generateRepo from '../src/commands/generateRepo.js';
import generateService from '../src/commands/generateService.js';
import generateCrud from '../src/commands/generateCrud.js';
import initLint from '../src/commands/initLint.js';
import initStructure from '../src/commands/generateStructure.js';
import initAliases from '../src/commands/initAliases.js';

const program = new Command();

program
    .name('azure-net')
    .description('Universal code generator')
    .version('1.0.0');

program
    .command('make:datasource')
    .description('Generate datasource')
    .action(generateDatasource);

program
    .command('make:repo')
    .description('Generate repo')
    .action(generateRepo);

program
    .command('make:request')
    .description('Generate request')
    .action(generateRequest);

program
    .command('make:service')
    .description('Generate service')
    .action(generateService);

program
    .command('make:crud')
    .description('Generate CRUD Domain/Repo/Service')
    .action(generateCrud);

program
    .command('init:lint')
    .description('Setup linting and commit tools')
    .action(initLint)

program
    .command('init:structure')
    .description('Generate base folder structure based on config')
    .action(initStructure);

program
    .command('init:aliases')
    .description('Generate alias mappings for modules or default architecture')
    .action(initAliases);

program
    .command('init')
    .description('Run all initialization steps: structure, aliases, lint')
    .action(async () => {
        await initStructure();
        await initAliases();
        await initLint();
    });

program.parse();