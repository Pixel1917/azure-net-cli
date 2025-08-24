import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../utils/loadConfig.js';
import { execSync } from 'child_process';

/** Файл конфигурации */
const svelteConfigPath = path.resolve('svelte.config.js');

function generateAliases(config) {
    const hasModules = Array.isArray(config.modules) && config.modules.length > 0;

    if (hasModules) {
        config.modules.push('shared-context');
        return Object.fromEntries(
            [
                ...config.modules.map(m => [`$${m}`, `./src/app/contexts/${m}`]),
                ['$core', './src/app/core'],
                ['$ui', './src/app/ui']
            ]
        );
    }

    return {
        '$app-context': './src/app/contexts/app-context',
        '$shared-context': './src/app/contexts/shared-context',
        '$core': './src/app/core',
        '$ui': './src/app/ui'
    };
}

function parseObjectLiteral(text) {
    const obj = {};
    const entries = text.split(/,(?![^{]*})/).filter(Boolean);
    for (const entry of entries) {
        const [key, value] = entry.split(':').map(s => s.trim());
        if (key && value) {
            obj[key.replace(/^['"]|['"]$/g, '')] = value.replace(/^['"]|['"]$/g, '');
        }
    }
    return obj;
}

function serializeObjectLiteral(obj) {
    return Object.entries(obj)
        .map(([key, value]) => `\t\t\t'${key}': '${value}'`)
        .join(',\n');
}

function insertAliasBlock(content, aliasBlock) {
    const kitRegex = /kit:\s*{([\s\S]*?)}/m;
    const match = content.match(kitRegex);

    if (!match) {
        throw new Error('❌ Cannot find `kit: {}` block in svelte.config.js');
    }

    const existingKit = match[0];
    const newKit = existingKit.includes('alias:')
        ? existingKit.replace(/alias:\s*{([\s\S]*?)}/m, aliasBlock)
        : existingKit.replace(/{/, `{\n\t\t${aliasBlock},`);

    return content.replace(kitRegex, newKit);
}

async function updateAliases() {
    const config = await loadUserConfig();
    const newAliases = generateAliases(config);

    let content = await fs.readFile(svelteConfigPath, 'utf-8');

    // если alias уже есть
    const aliasRegex = /alias:\s*{([\s\S]*?)}/m;
    const aliasMatch = content.match(aliasRegex);

    let updatedAliases = {};

    if (aliasMatch) {
        const existingAliases = parseObjectLiteral(aliasMatch[1]);
        updatedAliases = { ...existingAliases, ...newAliases };
    } else {
        updatedAliases = { ...newAliases };
    }

    const newAliasBlock = `alias: {\n${serializeObjectLiteral(updatedAliases)}\n\t\t}`;

    content = aliasMatch
        ? content.replace(aliasRegex, newAliasBlock)
        : insertAliasBlock(content, newAliasBlock);

    await fs.writeFile(svelteConfigPath, content, 'utf-8');
    console.log('✅ Aliases updated in svelte.config.js');

    // Run formatter
    try {
        execSync('npm run format', { stdio: 'inherit' });
    } catch {
        console.warn('⚠️ Failed to run format. Make sure you have a format script in package.json');
    }
}

export default updateAliases;