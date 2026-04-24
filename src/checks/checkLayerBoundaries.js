import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';

const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);

const IMPORT_FROM_PATTERN = /\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_PATTERN = /\bexport\s+(?:type\s+)?\{[\s\S]*?\}\sfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const toPosixPath = (value) => value.split(path.sep).join('/');

const normalizeAlias = (value, fallback = '') => {
	const raw = String(value ?? '').trim();
	if (!raw.length) return fallback;
	return raw.startsWith('$') ? raw : `$${raw}`;
};

const findLineByIndex = (content, index) => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};

const getRelativePath = (filePath) => toPosixPath(path.relative(process.cwd(), filePath));

const listFiles = async (rootDir) => {
	const files = [];
	const stack = [rootDir];

	while (stack.length) {
		const current = stack.pop();
		if (!current) continue;

		let entries = [];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) {
					stack.push(path.join(current, entry.name));
				}
				continue;
			}

			if (!entry.isFile()) continue;
			const filePath = path.join(current, entry.name);
			if (!TARGET_EXTENSIONS.has(path.extname(filePath))) continue;
			files.push(filePath);
		}
	}

	return files;
};

const extractImports = (content) => {
	const matches = [];
	const patterns = [IMPORT_FROM_PATTERN, EXPORT_FROM_PATTERN, DYNAMIC_IMPORT_PATTERN];

	for (const pattern of patterns) {
		const regex = new RegExp(pattern.source, 'g');
		let match;
		while ((match = regex.exec(content)) !== null) {
			const value = match[1];
			if (!value) continue;
			matches.push({ value, line: findLineByIndex(content, match.index) });
		}
	}

	return matches;
};

const resolveAliasFromImport = (importPath, aliases) => {
	const sorted = [...aliases].sort((a, b) => b.length - a.length);
	for (const alias of sorted) {
		if (importPath === alias || importPath.startsWith(`${alias}/`)) {
			return alias;
		}
	}
	return null;
};

const isSharedLikeContext = (contextName, alias) => {
	const normalizedName = contextName.toLowerCase();
	const normalizedAlias = alias.toLowerCase();
	return normalizedName.includes('shared') || normalizedAlias.includes('shared');
};

export default async function checkLayerBoundaries() {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);

	if (!contexts.length) {
		console.error('❌ No contexts found in azure-net.config.ts/js. Fill `contexts` first.');
		process.exitCode = 1;
		return;
	}

	const coreAlias = normalizeAlias(config.coreAlias, '$core');
	const sharedAliasRaw = normalizeAlias(config.sharedAlias, '');
	const sharedAlias = sharedAliasRaw.length ? sharedAliasRaw : null;

	const aliasToContext = new Map();
	for (const context of contexts) {
		aliasToContext.set(context.alias, context);
	}

	const knownAliases = [coreAlias, ...contexts.map((context) => context.alias)];
	if (sharedAlias && !knownAliases.includes(sharedAlias)) {
		knownAliases.push(sharedAlias);
	}

	const issues = [];

	for (const context of contexts) {
		const layersRoot = path.join(process.cwd(), 'src', 'app', context.name, 'layers');

		try {
			await fs.access(layersRoot);
		} catch {
			continue;
		}

		const files = await listFiles(layersRoot);
		const allowedAliases = new Set([context.alias, coreAlias]);
		if (sharedAlias) {
			allowedAliases.add(sharedAlias);
		}

		for (const filePath of files) {
			const content = await fs.readFile(filePath, 'utf-8');
			const imports = extractImports(content);

			for (const entry of imports) {
				const targetAlias = resolveAliasFromImport(entry.value, knownAliases);
				if (!targetAlias) continue;
				if (targetAlias === coreAlias) continue;
				if (allowedAliases.has(targetAlias)) continue;

				const targetContext = aliasToContext.get(targetAlias);
				const baseMessage = targetContext
					? `Layer boundary violation: context "${context.name}" cannot import from context "${targetContext.name}" (${targetAlias})`
					: `Layer boundary violation: context "${context.name}" cannot import from "${targetAlias}"`;

				const withSharedHint =
					!sharedAlias && targetContext && isSharedLikeContext(targetContext.name, targetAlias)
						? `${baseMessage}. sharedAlias is not configured in azure-net.config.ts/js; if this context is shared, set sharedAlias explicitly`
						: baseMessage;

				issues.push({
					file: filePath,
					line: entry.line,
					message: withSharedHint
				});
			}
		}
	}

	if (!issues.length) {
		console.log('✅ Layer boundaries check passed.');
		return;
	}

	console.error('❌ Layer boundaries check failed:');
	for (const issue of issues) {
		console.error(`• ${getRelativePath(issue.file)}:${issue.line} — ${issue.message}`);
	}

	process.exitCode = 1;
}
