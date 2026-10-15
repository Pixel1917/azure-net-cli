import fs from 'node:fs/promises';
import path from 'node:path';
import { getPlatformPath, normalizePascalName } from './architecture.js';
export { getContextPath, selectContext, selectPresentationWorkspace, discoverContexts, discoverPresentationWorkspaces, normalizePascalName } from './architecture.js';
export async function getAvailableFiles(dir, pattern = '.ts') {
    try {
        return (await fs.readdir(dir))
            .filter((file) => file.endsWith(pattern) && file !== 'index.ts')
            .map((file) => file.slice(0, -pattern.length));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
export async function getApplicationProviderServices() {
    try {
        const content = await fs.readFile(path.join(getPlatformPath(), 'Foundation/DI/ApplicationProvider.ts'), 'utf8');
        return Array.from(content.matchAll(/(\w+Service):\s*\(/g), (match) => match[1]);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
export function toPascalCase(str) {
    return str.trim() ? normalizePascalName(str) : '';
}
export function toCamelCase(str) {
    const pascal = toPascalCase(str);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
export function toKebabCase(str) {
    return str
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
        .toLowerCase();
}
