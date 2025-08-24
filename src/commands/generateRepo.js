import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../utils/loadConfig.js';

const CORE_DATASOURCES_PATH = path.join(process.cwd(), 'src/app/core/datasources');
const CONTEXTS_PATH = path.join(process.cwd(), 'src/app/contexts');

async function getAvailableDatasources() {
    try {
        const files = await fs.readdir(CORE_DATASOURCES_PATH);
        return files.filter(f => f.endsWith('.ts') && !f.startsWith('_')).map(f => f.replace('.ts', ''));
    } catch {
        return [];
    }
}

async function updateIndexTs(dir) {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.ts') && f !== 'index.ts');
    const content = files.map(f => `export * from './${f.replace('.ts', '')}';`).join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'index.ts'), content, 'utf-8');
}

export default async function generateRepo() {
    const config = await loadUserConfig();
    const datasources = await getAvailableDatasources();

    const answers = await prompts([
        config.modules?.length ? {
            type: 'select',
            name: 'module',
            message: 'Select target module:',
            choices: [...config.modules, 'shared-context'].map(m => ({ title: m, value: m }))
        } : null,
        { type: 'text', name: 'name', message: 'Repository class name (PascalCase):' },
        {
            type: 'select',
            name: 'datasource',
            message: 'Select datasource:',
            choices: datasources.map(d => ({ title: d, value: d }))
        }
    ].filter(Boolean));

    const { name, module, datasource } = answers;
    const capital = name.trim();

    const basePath = path.join(CONTEXTS_PATH, module || 'app-context');
    const repoDir = path.join(basePath, 'Infra', 'Repo');
    const filePath = path.join(repoDir, `${capital}Repo.ts`);

    const aliasRepo = module === 'shared-context'
        ? '$shared-context/Infra/Repo'
        : `$${module}/Infra/Repo`;

    const content = `import { ${datasource} } from '$core/datasources';

export class ${capital}Repo {
	private source = new ${datasource}();

	constructor() {
		// TODO: fill generated class
	}
}`;

    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(filePath, content);
    await updateIndexTs(repoDir);
    console.log(`✅ Repo created at ${filePath}`);
}
