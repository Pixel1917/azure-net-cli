import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { toCamelCase } from '../../utils/contextUtils.js';
const getRoutesDir = () => path.join(process.cwd(), 'src', 'routes');
const ROUTE_FILE_PATTERN = /^\+(page|server)(?:\.server)?\.(?:svelte|ts|js)$/;
const PAGE_FILE_PATTERN = /^\+page(?:\.server)?\.(?:svelte|ts|js)$/;
const SERVER_FILE_PATTERN = /^\+server\.(?:ts|js)$/;
const isRouteGroup = (segment) => /^\(.+\)$/.test(segment);
const getRouteGroupName = (segment) => segment.slice(1, -1).trim();
const extractParamName = (rawParam) => {
    const withoutRest = rawParam.startsWith('...') ? rawParam.slice(3) : rawParam;
    const matcherIndex = withoutRest.indexOf('=');
    return matcherIndex === -1 ? withoutRest : withoutRest.slice(0, matcherIndex);
};
const convertDynamicSegments = (segment) => {
    const optionalMatch = segment.match(/^\[\[(.+)\]\]$/);
    if (optionalMatch?.[1]) {
        const paramName = extractParamName(optionalMatch[1]);
        return { variants: ['', `{${paramName}}`], params: [paramName] };
    }
    const params = [];
    const converted = segment.replace(/\[(.+?)\]/g, (_match, rawParam) => {
        const paramName = extractParamName(rawParam);
        if (paramName.length)
            params.push(paramName);
        return `{${paramName}}`;
    });
    return { variants: [converted], params };
};
const normalizeUrl = (segments) => {
    const filtered = segments.filter(Boolean);
    return filtered.length ? `/${filtered.join('/')}` : '/';
};
const createRouteVariants = (segments) => {
    let variants = [[]];
    const dynamicParams = new Set();
    for (const segment of segments) {
        if (isRouteGroup(segment))
            continue;
        const converted = convertDynamicSegments(segment);
        for (const param of converted.params) {
            dynamicParams.add(param);
        }
        const nextVariants = [];
        for (const variant of variants) {
            for (const nextSegment of converted.variants) {
                nextVariants.push(nextSegment ? [...variant, nextSegment] : [...variant]);
            }
        }
        variants = nextVariants;
    }
    return {
        urls: [...new Set(variants.map(normalizeUrl))],
        dynamicParams: [...dynamicParams]
    };
};
const hasRouteFile = (files) => files.some((file) => ROUTE_FILE_PATTERN.test(file));
const hasPageFile = (files) => files.some((file) => PAGE_FILE_PATTERN.test(file));
const hasServerFile = (files) => files.some((file) => SERVER_FILE_PATTERN.test(file));
const readDirSafe = async (dir) => {
    try {
        return await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
};
const collectRoutes = async (dir, segments = [], groupStack = [], rootGroup) => {
    const entries = (await readDirSafe(dir)).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    const routes = [];
    const routeVariants = createRouteVariants(segments);
    if (hasRouteFile(files)) {
        for (const url of routeVariants.urls) {
            routes.push({
                url,
                routeDir: dir,
                relativeDir: path.relative(getRoutesDir(), dir) || '.',
                segments,
                dynamicParams: routeVariants.dynamicParams,
                rootGroup,
                groupStack,
                depth: segments.length,
                hasChildren: dirs.length > 0,
                hasPage: hasPageFile(files),
                hasServer: hasServerFile(files)
            });
        }
    }
    for (const child of dirs) {
        const childGroupName = isRouteGroup(child.name) ? getRouteGroupName(child.name) : undefined;
        const nextGroupStack = childGroupName ? [...groupStack, childGroupName] : groupStack;
        const nextRootGroup = rootGroup ?? (segments.length === 0 ? childGroupName : undefined);
        const childRoutes = await collectRoutes(path.join(dir, child.name), [...segments, child.name], nextGroupStack, nextRootGroup);
        routes.push(...childRoutes);
    }
    return routes;
};
const sanitizeGroupName = (value) => {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : 'routes';
};
const toRouteVariableName = (groupName) => {
    const base = toCamelCase(sanitizeGroupName(groupName).replace(/[^\p{L}\p{N}_-]+/gu, '-'));
    return `${base || 'routes'}Routes`;
};
const ensureUniqueVariableName = (name, used) => {
    if (!used.has(name)) {
        used.add(name);
        return name;
    }
    let index = 2;
    let nextName = `${name}${index}`;
    while (used.has(nextName)) {
        index += 1;
        nextName = `${name}${index}`;
    }
    used.add(nextName);
    return nextName;
};
const createGroupMap = (routes, mode, resolver) => {
    const groups = new Map();
    for (const route of routes) {
        const groupName = mode === 'none'
            ? 'routes'
            : mode === 'root-groups'
                ? (route.rootGroup ?? 'routes')
                : (sanitizeGroupName(String(resolver?.(route) ?? 'routes')) ?? 'routes');
        const list = groups.get(groupName) ?? [];
        list.push(route);
        groups.set(groupName, list);
    }
    return groups;
};
const createStringArray = (items, indent = '\t') => {
    if (!items.length)
        return '[]';
    return `[\n${items.map((item) => `${indent}'${item}'`).join(',\n')}\n]`;
};
const createGeneratedFile = (groups) => {
    const usedVariables = new Set();
    const groupEntries = [...groups.entries()].map(([groupName, routes]) => ({
        groupName,
        variableName: ensureUniqueVariableName(groupName === 'routes' ? (groups.size === 1 ? 'routes' : 'ungroupedRoutes') : toRouteVariableName(groupName), usedVariables),
        routes: [...new Set(routes.map((route) => route.url))].sort((a, b) => a.localeCompare(b))
    }));
    const lines = ['// This file is generated by `azure-net generate routes`.', '// Do not edit it manually.', ''];
    for (const group of groupEntries) {
        lines.push(`export const ${group.variableName} = ${createStringArray(group.routes)} as const;`);
        lines.push('');
    }
    if (groupEntries.length !== 1 || groupEntries[0]?.variableName !== 'routes') {
        lines.push(`export const routes = [${groupEntries.map((group) => `...${group.variableName}`).join(', ')}] as const;`);
        lines.push('');
    }
    lines.push('export type Route = (typeof routes)[number];');
    lines.push('');
    return `${lines.join('\n')}\n`;
};
const selectGroupingMode = async () => {
    const { mode } = await prompts({
        type: 'select',
        name: 'mode',
        message: 'How should routes be grouped?',
        choices: [
            { title: 'By root route groups: (account), (landing), ...', value: 'root-groups' },
            { title: 'By azure-net.config.ts groupRoutesFunc', value: 'config-function' },
            { title: 'Do not group, generate one routes array', value: 'none' }
        ]
    });
    return mode ? mode : null;
};
const getConfigRouteGroupResolver = async () => {
    const config = await loadUserConfig();
    if (typeof config.groupRoutesFunc !== 'function') {
        console.error('❌ `groupRoutesFunc` is missing in azure-net.config.ts/js or is not a function.');
        console.error('Example:');
        console.error('export default {');
        console.error("\tgroupRoutesFunc: (route) => route.rootGroup ?? 'app'");
        console.error('};');
        return null;
    }
    return config.groupRoutesFunc;
};
export default async function generateRoutes() {
    const mode = await selectGroupingMode();
    if (!mode)
        return;
    const resolver = mode === 'config-function' ? await getConfigRouteGroupResolver() : undefined;
    if (mode === 'config-function' && !resolver) {
        process.exitCode = 1;
        return;
    }
    const routes = await collectRoutes(getRoutesDir());
    if (!routes.length) {
        console.warn('⚠️ No SvelteKit routes found in src/routes');
        return;
    }
    const groups = createGroupMap(routes, mode, resolver ?? undefined);
    const outputDir = path.join(process.cwd(), 'src', 'app', 'Platform', 'Bootstrap', 'Routes');
    const outputFile = path.join(outputDir, 'index.ts');
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputFile, createGeneratedFile(groups), 'utf-8');
    console.log(`✅ Routes generated: ${outputFile}`);
}
