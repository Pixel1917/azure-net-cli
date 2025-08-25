import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { execSync } from 'child_process';

const svelteConfigPath = path.resolve('svelte.config.js');

function generateAliases(config) {
    const contexts = config.contexts || ['app'];

    return Object.fromEntries([
        ...contexts.map(c => [`$${c}`, `./src/app/contexts/${c}`]),
        ['$core', './src/app/core'],
        ['$lib', './src/lib']
    ]);
}

function serializeObjectLiteral(obj) {
    return Object.entries(obj)
        .map(([key, value]) => `\t\t\t'${key}': '${value}'`)
        .join(',\n');
}

export default async function initAliases() {
    const config = await loadUserConfig();
    const newAliases = generateAliases(config);

    let content = await fs.readFile(svelteConfigPath, 'utf-8');

    const aliasRegex = /alias:\s*{([\s\S]*?)}/m;
    const aliasMatch = content.match(aliasRegex);

    const newAliasBlock = `alias: {\n${serializeObjectLiteral(newAliases)}\n\t\t}`;

    if (aliasMatch) {
        content = content.replace(aliasRegex, newAliasBlock);
    } else {
        const kitRegex = /kit:\s*{/;
        content = content.replace(kitRegex, `kit: {\n\t\t${newAliasBlock},`);
    }

    await fs.writeFile(svelteConfigPath, content, 'utf-8');
    console.log('✅ Aliases updated in svelte.config.js');

    try {
        execSync('npm run format', { stdio: 'inherit' });
    } catch {
        console.warn('⚠️ Failed to run format');
    }
}