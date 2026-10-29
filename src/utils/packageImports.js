import fs from 'node:fs/promises';
import path from 'node:path';
import { format } from 'prettier';
export const PACKAGE_IMPORTS = Object.fromEntries(['Contexts', 'Presentation', 'Platform'].flatMap((name) => {
    const key = '#' + name.toLowerCase(), root = name === 'Platform' ? './src/platform' : './src/app/' + name;
    return [[key + '/*', { types: [root + '/*.ts', root + '/*/index.ts', root + '/*'], default: root + '/*' }]];
}));
export async function mergePackageImports(content) {
    const json = JSON.parse(content);
    if (!json || typeof json !== 'object' || Array.isArray(json))
        throw new Error('Expected a package.json object');
    if (json.imports !== undefined && (!json.imports || typeof json.imports !== 'object' || Array.isArray(json.imports)))
        throw new Error('Expected package.json imports object');
    const imports = { ...json.imports };
    for (const [key, value] of Object.entries(PACKAGE_IMPORTS)) {
        if (key in imports && JSON.stringify(imports[key]) !== JSON.stringify(value))
            throw new Error(`Conflicting package import ${key}; review its target before initialization.`);
        imports[key] = value;
    }
    return format(JSON.stringify({ ...json, imports }), { parser: 'json', useTabs: true });
}
export async function initializePackageImports() {
    const file = path.resolve('package.json');
    let content;
    try {
        content = await fs.readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        content = '{}';
    }
    await fs.writeFile(file, await mergePackageImports(content));
}
export function resolvePackageImport(imports, specifier, root) {
    const target = (v) => {
        if (typeof v === 'string')
            return v;
        if (Array.isArray(v))
            return v.map(target).find(Boolean);
        if (v && typeof v === 'object') {
            const obj = v;
            return target(obj.default ?? obj.import ?? obj.types);
        }
    };
    for (const key of Object.keys(imports).sort((a, b) => b.replace('*', '').length - a.replace('*', '').length)) {
        const value = target(imports[key]);
        if (!value?.startsWith('./'))
            continue;
        if (!key.includes('*')) {
            if (key === specifier)
                return path.resolve(root, value);
            continue;
        }
        const [prefix, suffix = ''] = key.split('*');
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix))
            return path.resolve(root, value.replace('*', specifier.slice(prefix.length, suffix ? -suffix.length : undefined)));
    }
    return null;
}
