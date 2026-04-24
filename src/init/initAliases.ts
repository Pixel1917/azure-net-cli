import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig, resolveConfigFile } from '../utils/loadConfig.js';

const svelteConfigPath = path.resolve('svelte.config.js');

type ContextInput = string | { name?: string; alias?: string } | null | undefined;
type ContextConfig = { name: string; alias: string };

function normalizeAliasValue(value: unknown, fallbackName: string): string {
	const raw = String(value ?? '').trim();
	if (!raw.length) return `$${fallbackName}`;
	return raw.startsWith('$') ? raw : `$${raw}`;
}

export function normalizeContexts(rawContexts: unknown): ContextConfig[] {
	if (!Array.isArray(rawContexts)) return [];

	return (rawContexts as ContextInput[])
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
		.filter((item): item is ContextConfig => item !== null);
}

export function generateAliases(config: { coreAlias?: string; contexts?: unknown }): {
	coreAlias: string;
	contexts: ContextConfig[];
	aliases: Record<string, string>;
} {
	const coreAlias = normalizeAliasValue(config.coreAlias, 'core');
	const contexts = normalizeContexts(config.contexts);

	const entries: Array<[string, string]> = [];
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

function parseAliasEntries(aliasBody: string): { ordered: string[]; map: Map<string, string> } {
	const entryRegex = /(['"`])([^'"`]+)\1\s*:\s*(['"`])([^'"`]+)\3\s*,?/g;
	const ordered: string[] = [];
	const map = new Map<string, string>();
	let match: RegExpExecArray | null;

	while ((match = entryRegex.exec(aliasBody)) !== null) {
		const key = match[2];
		const value = match[4];
		if (!key || !value) continue;
		if (!map.has(key)) {
			ordered.push(key);
		}
		map.set(key, value);
	}

	return { ordered, map };
}

function buildAliasEntriesString(orderedKeys: string[], map: Map<string, string>, baseIndent: string): string {
	if (!orderedKeys.length) return '';

	return orderedKeys.map((key) => `${baseIndent}'${key}': '${map.get(key) ?? ''}'`).join(',\n');
}

export function mergeAliasesInSvelteConfig(content: string, aliases: Record<string, string>): string {
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

function upsertCoreAlias(content: string, coreAlias: string): string {
	const exportDefaultRegex = /export\s+default\s*\{([\s\S]*)\}\s*;?/m;
	if (!exportDefaultRegex.test(content)) {
		return `export default {\n\tcoreAlias: '${coreAlias}'\n};\n`;
	}

	if (/coreAlias\s*:/.test(content)) {
		return content.replace(/coreAlias\s*:\s*['"`][^'"`]+['"`]/, `coreAlias: '${coreAlias}'`);
	}

	return content.replace(exportDefaultRegex, (_full, body: string) => {
		const trimmed = body.replace(/\s*$/, '');
		if (!trimmed.length) {
			return `export default {\n\tcoreAlias: '${coreAlias}'\n};`;
		}

		const withComma = trimmed.endsWith(',') ? trimmed : `${trimmed},`;
		return `export default {${withComma}\n\tcoreAlias: '${coreAlias}'\n};`;
	});
}

export async function ensureCoreAliasInConfig(coreAlias: string): Promise<string> {
	const { exists, filepath } = resolveConfigFile();
	const aliasToSave = normalizeAliasValue(coreAlias, 'core');
	const currentContent = exists ? await fs.readFile(filepath, 'utf-8') : '';
	const nextContent = upsertCoreAlias(currentContent, aliasToSave);
	await fs.writeFile(filepath, nextContent, 'utf-8');
	return aliasToSave;
}

export default async function initAliases(): Promise<void> {
	const config = await loadUserConfig();
	const generated = generateAliases(config as { coreAlias?: string; contexts?: unknown });
	const actualCoreAlias = await ensureCoreAliasInConfig(generated.coreAlias);
	const aliases = { ...generated.aliases, [actualCoreAlias]: './src/core' };

	let content: string;
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
