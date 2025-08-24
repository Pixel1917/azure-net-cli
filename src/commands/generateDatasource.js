import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';

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

async function updateIndexTs(dir) {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.ts') && f !== 'index.ts');
    const content = files.map(f => `export * from './${f.replace('.ts', '')}';`).join('\n') + '\n';
    await fs.writeFile(path.join(dir, 'index.ts'), content, 'utf-8');
}

export default async function generateDatasource() {
    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Datasource class name (PascalCase, e.g., BackendApi):'
    });

    const capital = name.trim();
    const filePath = path.join(CORE_DATASOURCES_PATH, `${capital}Datasource.ts`);

    const content = `import { BaseHttpDatasource, HttpService } from '@azure-net/kit';

export class ${capital}Datasource extends BaseHttpDatasource {
	constructor() {
		super({ http: new HttpService({ baseUrl: '' }) }); // TODO: fill generated class
	}
}`;

    await writeIfNotExists(filePath, content);
    await updateIndexTs(CORE_DATASOURCES_PATH);
}