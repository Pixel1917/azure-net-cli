import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import ejs from 'ejs';
import { loadUserConfig } from '../utils/loadConfig.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CONTEXTS_PATH = path.join(process.cwd(), 'src/app/contexts');

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

async function updateIndexTs(dir) {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.ts') && f !== 'index.ts');
    const content = files.map(f => `export * from './${f.replace('.ts', '')}';`).join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'index.ts'), content, 'utf-8');
}

async function getAvailableSubfolders(baseDomainPath) {
    try {
        const entries = await fs.readdir(baseDomainPath, { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
        return [];
    }
}

export default async function generateRequest() {
    const config = await loadUserConfig();

    const { module } = await prompts({
        type: 'select',
        name: 'module',
        message: 'Select target module:',
        choices: [...config.modules, 'shared-context'].map(m => ({ title: m, value: m }))
    });

    const { className } = await prompts({
        type: 'text',
        name: 'className',
        message: 'Request class name (PascalCase, without `Request` suffix):'
    });

    const pascalCaseName = className.trim();
    const aliasModule = module === 'shared-context' ? '$shared-context' : `$${module}`;

    const domainPath = path.join(CONTEXTS_PATH, module, 'Domain');
    const availableSub = await getAvailableSubfolders(domainPath);

    const { submodule } = await prompts({
        type: 'autocomplete',
        name: 'submodule',
        message: 'Select or enter submodule:',
        choices: [...availableSub.map(s => ({ title: s, value: s })), { title: '[Create new submodule]', value: '__custom' }]
    });

    let actualSub = submodule;
    if (submodule === '__custom') {
        const { newSub } = await prompts({
            type: 'text',
            name: 'newSub',
            message: 'Enter new submodule name:'
        });
        actualSub = newSub.trim();
    }

    const basePath = path.join(domainPath, actualSub);
    const abstractsDir = path.join(basePath, 'Abstracts');
    const requestDir = path.join(basePath, 'Request');

    const templateData = { pascalCaseName };

    const abstractTpl = `export interface I${pascalCaseName}Request {
    // TODO: define fields
    [key: string]: unknown;
}`;
    await writeIfNotExists(path.join(abstractsDir, `I${pascalCaseName}Request.ts`), abstractTpl);
    await updateIndexTs(abstractsDir);

    const requestTplPath = path.join(__dirname, '../templates/domain/request/ClassRequest.ejs');
    const tpl = await fs.readFile(requestTplPath, 'utf-8');
    const result = ejs.render(tpl, templateData);
    await writeIfNotExists(path.join(requestDir, `${pascalCaseName}Request.ts`), result);
    await updateIndexTs(requestDir);

    console.log(`✅ Request generated in ${path.join(module, actualSub)}`);
}