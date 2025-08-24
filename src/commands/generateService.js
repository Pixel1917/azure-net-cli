import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../utils/loadConfig.js';

const CONTEXTS_PATH = path.join(process.cwd(), 'src/app/contexts');

async function getAvailableRepos(module) {
    const repoPath = path.join(CONTEXTS_PATH, module, 'Infra', 'Repo');
    try {
        const files = await fs.readdir(repoPath);
        return ['Without repo', ...files.filter(f => f.endsWith('.ts') && f !== 'index.ts').map(f => f.replace('.ts', ''))];
    } catch {
        return ['Without repo'];
    }
}

async function updateIndexTs(dir) {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.ts') && f !== 'index.ts');
    const content = files.map(f => `export * from './${f.replace('.ts', '')}';`).join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'index.ts'), content, 'utf-8');
}

export default async function generateService() {
    const config = await loadUserConfig();

    const { module } = await prompts({
        type: 'select',
        name: 'module',
        message: 'Select target module:',
        choices: [...config.modules, 'shared-context'].map(m => ({ title: m, value: m }))
    });

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Service class name (PascalCase):'
    });

    const repos = await getAvailableRepos(module);
    const { repo } = await prompts({
        type: 'select',
        name: 'repo',
        message: 'Select repository:',
        choices: repos.map(r => ({ title: r, value: r }))
    });

    const capital = name.trim();
    const basePath = path.join(CONTEXTS_PATH, module || 'app-context');
    const serviceDir = path.join(basePath, 'Application', 'Services');
    const filePath = path.join(serviceDir, `${capital}Service.ts`);

    const aliasRepo = module === 'shared-context'
        ? '$shared-context/Infra/Repo'
        : `$${module}/Infra/Repo`;

    const content = repo === 'Without repo'
        ? `export class ${capital}Service {
	constructor() {
		// TODO: fill generated class
	}
}`
        : `import { ${repo} } from '${aliasRepo}';

export class ${capital}Service {
	private repo = new ${repo}();

	constructor() {
		// TODO: fill generated class
	}
}`;

    await fs.mkdir(serviceDir, { recursive: true });
    await fs.writeFile(filePath, content);
    await updateIndexTs(serviceDir);
    console.log(`✅ Service created at ${filePath}`);
}
