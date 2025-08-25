import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';
import { loadUserConfig } from './loadConfig.js';

const CONTEXTS_PATH = path.join(process.cwd(), 'src/app/contexts');
const CORE_PATH = path.join(process.cwd(), 'src/app/core');

export async function selectContext(message = 'Select context:') {
    const config = await loadUserConfig();
    const contexts = config.contexts || ['app'];

    const { context } = await prompts({
        type: 'select',
        name: 'context',
        message,
        choices: [
            ...contexts.map(c => ({ title: c, value: c })),
            { title: 'core (shared)', value: 'core' }
        ]
    });

    return context;
}

export function getContextPath(context) {
    return context === 'core'
        ? CORE_PATH
        : path.join(CONTEXTS_PATH, context);
}

export async function getAvailableFiles(dir, pattern = '.ts') {
    try {
        const files = await fs.readdir(dir);
        return files
            .filter(f => f.endsWith(pattern) && f !== 'index.ts')
            .map(f => f.replace(pattern, ''));
    } catch {
        return [];
    }
}

export function toPascalCase(str) {
    return str
        .split(/[-_\s]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}

export function toCamelCase(str) {
    const pascal = toPascalCase(str);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}