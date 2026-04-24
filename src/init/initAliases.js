import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig, resolveConfigFile } from '../utils/loadConfig.js';

const svelteConfigPath = path.resolve('svelte.config.js');

function normalizeAliasValue(value, fallbackName) {
	const raw = String(value ?? '').trim();
	if (!raw.length) return `$${fallbackName}`;
	return raw.startsWith('$') ? raw : `$${raw}`;
}

export function normalizeContexts(rawContexts) {
	if (!Array.isArray(rawContexts)) return [];

	return rawContexts
		.map((item) => {
			if (typeof item === 'string') {
				const name = item.trim();
				if (!name.length) return null;
				return { name, alias: `$${name}` };
			}

			if (!item || typeof item !== 'object') return null;

			const name = String(item.name ?? '').trim();
			if (!name.length) return null;

			return {
				name,
				alias: normalizeAliasValue(item.alias, name)
			};
		})
		.filter(Boolean);
}

export function generateAliases(config) {
	const coreAlias = normalizeAliasValue(config.coreAlias, 'core');
	const contexts = normalizeContexts(config.contexts);

	const entries = [];
	for (const context of contexts) {
		entries.push([context.alias, `./src/app/${context.name}`]);
	}

	entries.push([coreAlias, './src/core']);

	return {
		coreAlias,
		contexts,
		aliases: Object.fromEntries(entries)
	};
}

function parseAliasEntries(aliasBody) {
	const entryRegex = /(['"`])([^'"`]+)\1\s*:\s*(['"`])([^'"`]+)\3\s*,?/g;
	const ordered = [];
	const map = new Map();
	let match;

	while ((match = entryRegex.exec(aliasBody)) !== null) {
		const key = match[2];
		const value = match[4];
		if (!map.has(key)) {
			ordered.push(key);
		}
		map.set(key, value);
	}

	return { ordered, map };
}

function buildAliasEntriesString(orderedKeys, map, baseIndent) {
	if (!orderedKeys.length) return '';

	return orderedKeys.map((key) => `${baseIndent}'${key}': '${map.get(key)}'`).join(',\n');
}

export function mergeAliasesInSvelteConfig(content, aliases) {
	const aliasRegex = /alias\s*:\s*\{([\s\S]*?)\}/m;
	const aliasMatch = content.match(aliasRegex);

	if (aliasMatch) {
		const aliasBody = aliasMatch[1] ?? '';
		const { ordered, map } = parseAliasEntries(aliasBody);
		for (const [key, value] of Object.entries(aliases)) {
			if (!map.has(key)) ordered.push(key);
			map.set(key, value);
		}

		const baseIndentMatch = aliasBody.match(/\n(\s*)['"`]/);
		const baseIndent = baseIndentMatch?.[1] ?? '\t\t\t';
		const merged = buildAliasEntriesString(ordered, map, baseIndent);
		const nextAliasBlock = `alias: {\n${merged}\n\t\t}`;
		return content.replace(aliasRegex, nextAliasBlock);
	}

	const kitRegex = /kit\s*:\s*\{/m;
	if (kitRegex.test(content)) {
		const aliasLines = Object.entries(aliases)
			.map(([key, value]) => `\t\t\t'${key}': '${value}'`)
			.join(',\n');
		const aliasBlock = `alias: {\n${aliasLines}\n\t\t},`;
		return content.replace(kitRegex, `kit: {\n\t\t${aliasBlock}`);
	}

	return `${content}\n\n// azure-net aliases\nconst alias = {\n${Object.entries(aliases)
		.map(([key, value]) => `\t'${key}': '${value}'`)
		.join(',\n')}\n};\n`;
}

function upsertCoreAlias(content, coreAlias) {
	const exportDefaultRegex = /export\s+default\s*\{([\s\S]*)\}\s*;?/m;
	if (!exportDefaultRegex.test(content)) {
		return `export default {\n\tcoreAlias: '${coreAlias}'\n};\n`;
	}

	if (/coreAlias\s*:/.test(content)) {
		return content.replace(/coreAlias\s*:\s*['"`][^'"`]+['"`]/, `coreAlias: '${coreAlias}'`);
	}

	return content.replace(exportDefaultRegex, (_full, body) => {
		const trimmed = body.replace(/\s*$/, '');
		if (!trimmed.length) {
			return `export default {\n\tcoreAlias: '${coreAlias}'\n};`;
		}

		const withComma = trimmed.endsWith(',') ? trimmed : `${trimmed},`;
		return `export default {${withComma}\n\tcoreAlias: '${coreAlias}'\n};`;
	});
}

export async function ensureCoreAliasInConfig(coreAlias) {
	const { exists, filepath } = resolveConfigFile();
	const aliasToSave = normalizeAliasValue(coreAlias, 'core');
	const currentContent = exists ? await fs.readFile(filepath, 'utf-8') : '';
	const nextContent = upsertCoreAlias(currentContent, aliasToSave);
	await fs.writeFile(filepath, nextContent, 'utf-8');
	return aliasToSave;
}

export default async function initAliases() {
	const config = await loadUserConfig();
	const generated = generateAliases(config);
	const actualCoreAlias = await ensureCoreAliasInConfig(generated.coreAlias);
	const aliases = { ...generated.aliases, [actualCoreAlias]: './src/core' };

	let content;
	try {
		content = await fs.readFile(svelteConfigPath, 'utf-8');
	} catch {
		console.warn('⚠️ svelte.config.js not found, aliases were not updated');
		return;
	}

	const nextContent = mergeAliasesInSvelteConfig(content, aliases);
	await fs.writeFile(svelteConfigPath, nextContent, 'utf-8');
	console.log('✅ Aliases updated in svelte.config.js');
}
