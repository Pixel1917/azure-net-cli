import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';

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

export function generateAliases(config: { contexts?: unknown }): {
	contexts: ContextConfig[];
	aliases: Record<string, string>;
} {
	const contexts = normalizeContexts(config.contexts);

	const entries: Array<[string, string]> = [];
	for (const context of contexts) {
		entries.push([context.alias, `./src/app/${context.name}`]);
	}

	return {
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

function removeAliasEntry(content: string, alias: string): string {
	const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const aliasRegex = new RegExp(`\\n?\\s*['"\`]${escapedAlias}['"\`]\\s*:\\s*['"\`][^'"\`]+['"\`]\\s*,?`, 'g');
	return content.replace(aliasRegex, '');
}

const removeCoreAliasFromAzureNetConfig = async (): Promise<void> => {
	const tsPath = path.resolve('azure-net.config.ts');
	const jsPath = path.resolve('azure-net.config.js');
	let filepath: string | null = null;

	try {
		await fs.access(tsPath);
		filepath = tsPath;
	} catch {
		try {
			await fs.access(jsPath);
			filepath = jsPath;
		} catch {
			return;
		}
	}

	const content = await fs.readFile(filepath, 'utf-8');
	if (!/coreAlias\s*:/.test(content)) return;

	const nextContent = content.replace(/\n?\s*coreAlias\s*:\s*['"`][^'"`]+['"`]\s*,?/m, '').replace(/,\s*\n\s*\}/m, '\n}');
	await fs.writeFile(filepath, nextContent, 'utf-8');
};

export function mergeAliasesInSvelteConfig(content: string, aliases: Record<string, string>): string {
	const aliasRegex = /alias\s*:\s*\{([\s\S]*?)\}/m;
	const aliasMatch = content.match(aliasRegex);

	if (aliasMatch) {
		const aliasBody = aliasMatch[1] ?? '';
		const { ordered, map } = parseAliasEntries(aliasBody);
		map.delete('$core');
		for (const [key, value] of Object.entries(aliases)) {
			if (!map.has(key)) ordered.push(key);
			map.set(key, value);
		}
		const nextOrdered = ordered.filter((key) => key !== '$core');

		const baseIndentMatch = aliasBody.match(/\n(\s*)['"`]/);
		const baseIndent = baseIndentMatch?.[1] ?? '\t\t\t';
		const merged = buildAliasEntriesString(nextOrdered, map, baseIndent);
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

export default async function initAliases(): Promise<void> {
	const config = await loadUserConfig();
	const sharedAlias = String(config.sharedAlias ?? '').trim();
	if (!sharedAlias.length) {
		console.error('❌ Cannot update aliases: `sharedAlias` is missing in azure-net.config.ts/js.');
		console.error("Add it first, for example: sharedAlias: '$shared-kernel'");
		process.exitCode = 1;
		return;
	}

	const generated = generateAliases(config as { contexts?: unknown });
	const aliases = generated.aliases;
	await removeCoreAliasFromAzureNetConfig();

	let content: string;
	try {
		content = await fs.readFile(svelteConfigPath, 'utf-8');
	} catch {
		console.warn('⚠️ svelte.config.js not found, aliases were not updated');
		return;
	}

	const nextContent = removeAliasEntry(mergeAliasesInSvelteConfig(content, aliases), '$core');
	await fs.writeFile(svelteConfigPath, nextContent, 'utf-8');
	console.log('✅ Aliases updated in svelte.config.js');
}
