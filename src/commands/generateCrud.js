import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import ejs from 'ejs';
import { loadUserConfig } from '../utils/loadConfig.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CORE_DATASOURCES_PATH = path.join(process.cwd(), 'src/app/core/datasources');

async function writeIfNotExists(filepath, content) {
    try {
        await fs.access(filepath);
        console.log(`⚠️  Skip existing: ${filepath}`);
    } catch {
        await fs.mkdir(path.dirname(filepath), { recursive: true });
        await fs.writeFile(filepath, content, 'utf-8');
        console.log(`✅ Created: ${filepath}`);
    }
}

async function updateIndexTs(dir, filePattern = '.ts', ignore = ['index.ts']) {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith(filePattern) && !ignore.includes(f));
    const content = files.map(f => `export * from './${f.replace('.ts', '')}';`).join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'index.ts'), content, 'utf-8');
}

async function getAvailableDatasources() {
    try {
        const files = await fs.readdir(CORE_DATASOURCES_PATH);
        return files
            .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
            .map(f => f.replace('.ts', ''));
    } catch {
        return [];
    }
}

export default async function generateCrud() {
    const config = await loadUserConfig();
    const datasources = await getAvailableDatasources();

    const answers = await prompts([
        config.modules?.length
            ? {
                type: 'select',
                name: 'module',
                message: 'Select target module:',
                choices: [...config.modules, 'shared-context'].map(m => ({
                    title: m === 'shared-context' ? 'shared-context (shared)' : m,
                    value: m
                }))
            }
            : null,
        { type: 'text', name: 'className', message: 'Class name (PascalCase):' },
        { type: 'text', name: 'endpoint', message: 'API endpoint:' },
        {
            type: 'select',
            name: 'datasource',
            message: 'Select datasource:',
            choices: datasources.map(d => ({ title: d, value: d }))
        }
    ].filter(Boolean));

    const rawName = answers.className.trim();
    const capital = rawName[0].toUpperCase() + rawName.slice(1);
    const lower = rawName[0].toLowerCase() + rawName.slice(1);
    const endpoint = answers.endpoint.trim();
    const datasource = answers.datasource.trim();
    const selectedModule = answers.module;

    const baseArch = path.join(process.cwd(), 'src/app/contexts');
    const basePath = selectedModule ? path.join(baseArch, selectedModule) : path.join(baseArch, 'app-context');

    const domainPath = path.join(basePath, 'Domain', capital);
    const serviceDir = path.join(basePath, 'Application', 'Services');
    const repoPath = path.join(basePath, 'Infra', 'Repo');

    const aliasCurrent = selectedModule === 'shared-context'
        ? '$shared-context'
        : selectedModule
            ? `$${selectedModule}`
            : '$app-context';
    const aliasShared = '$shared-context';

    const templateData = {
        camelCaseName: lower,
        pascalCaseName: capital,
        endpoint,
        datasource,
        aliasDomain: `${aliasCurrent}/Domain`,
        aliasShared,
        aliasApplication: `${aliasCurrent}/Application`,
        aliasInfra: `${aliasCurrent}/Infra`,
        aliasRepo: `${aliasCurrent}/Infra/Repo`
    };

    // === 1) Abstracts
    const abstractsDir = path.join(domainPath, 'Abstracts');
    for (const file of ['Class', 'ClassCreateRequest', 'ClassUpdateRequest', 'ClassCollectionQuery']) {
        const tpl = await fs.readFile(path.join(__dirname, `../templates/domain/abstracts/${file}.ejs`), 'utf-8');
        const result = ejs.render(tpl, templateData);
        await writeIfNotExists(path.join(abstractsDir, `${capital}${file.replace('Class', '')}.ts`), result);
    }
    await updateIndexTs(abstractsDir);

    // === 2) Request
    const requestDir = path.join(domainPath, 'Request');
    for (const file of ['ClassCreateRequest', 'ClassUpdateRequest']) {
        const tpl = await fs.readFile(path.join(__dirname, `../templates/domain/request/${file}.ejs`), 'utf-8');
        const result = ejs.render(tpl, templateData);
        await writeIfNotExists(path.join(requestDir, `${capital}${file.replace('Class', '')}.ts`), result);
    }
    await updateIndexTs(requestDir);

    // === 3) Services
    const serviceTpl = await fs.readFile(path.join(__dirname, '../templates/domain/services/ClassService.ejs'), 'utf-8');
    const serviceResult = ejs.render(serviceTpl, templateData);
    await writeIfNotExists(path.join(serviceDir, `${capital}Service.ts`), serviceResult);
    await updateIndexTs(serviceDir);

    // === 4) Domain Index
    await writeIfNotExists(
        path.join(domainPath, 'index.ts'),
        [`export * from './Abstracts';`, `export * from './Request';`].join('\n')
    );
    //await updateIndexTs(domainPath);

    // === 5) Repo
    const repoTpl = await fs.readFile(path.join(__dirname, '../templates/data/repo/ClassRepo.ejs'), 'utf-8');
    const repoResult = ejs.render(repoTpl, templateData);
    await writeIfNotExists(path.join(repoPath, `${capital}Repo.ts`), repoResult);
    await updateIndexTs(repoPath);

    console.log(`✅ CRUD for ${capital} generated in ${selectedModule || 'app-context'} structure`);
}