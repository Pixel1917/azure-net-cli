import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';
import { SHARED_ESSENTIALS_DIR_NAME } from '../utils/sharedFoundation.js';

type BoundaryIssue = {
	file: string;
	line: number;
	message: string;
};

type ContextConfig = {
	name: string;
	alias: string;
};

const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);

const IMPORT_FROM_PATTERN = /\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_PATTERN = /\bexport\s+(?:type\s+)?\{[\s\S]*?\}\sfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const toPosixPath = (value: string): string => value.split(path.sep).join('/');

const normalizeAlias = (value: unknown, fallback = ''): string => {
	const raw = String(value ?? '').trim();
	if (!raw.length) return fallback;
	return raw.startsWith('$') ? raw : `$${raw}`;
};

const findLineByIndex = (content: string, index: number): number => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};

const getRelativePath = (filePath: string): string => toPosixPath(path.relative(process.cwd(), filePath));

const listFiles = async (rootDir: string): Promise<string[]> => {
	const files: string[] = [];
	const stack: string[] = [rootDir];

	while (stack.length) {
		const current = stack.pop();
		if (!current) continue;

		let entries: import('node:fs').Dirent[] = [];
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

const extractImports = (content: string): Array<{ value: string; line: number }> => {
	const matches: Array<{ value: string; line: number }> = [];
	const patterns = [IMPORT_FROM_PATTERN, EXPORT_FROM_PATTERN, DYNAMIC_IMPORT_PATTERN];

	for (const pattern of patterns) {
		const regex = new RegExp(pattern.source, 'g');
		let match: RegExpExecArray | null;
		while ((match = regex.exec(content)) !== null) {
			const value = match[1];
			if (!value) continue;
			matches.push({ value, line: findLineByIndex(content, match.index) });
		}
	}

	return matches;
};

const resolveAliasFromImport = (importPath: string, aliases: string[]): string | null => {
	const sorted = [...aliases].sort((a, b) => b.length - a.length);
	for (const alias of sorted) {
		if (importPath === alias || importPath.startsWith(`${alias}/`)) {
			return alias;
		}
	}
	return null;
};

const resolveContextFromRelativeImport = (filePath: string, importPath: string, contexts: ContextConfig[]): ContextConfig | null => {
	if (!importPath.startsWith('.')) return null;

	const absoluteImportPath = path.resolve(path.dirname(filePath), importPath);
	const appRoot = path.join(process.cwd(), 'src', 'app');

	for (const context of contexts) {
		const contextRoot = path.join(appRoot, context.name);
		if (absoluteImportPath === contextRoot || absoluteImportPath.startsWith(`${contextRoot}${path.sep}`)) {
			return context;
		}
	}

	return null;
};

const isInside = (targetPath: string, rootPath: string): boolean =>
	targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);

const resolveAbsoluteRelativeImport = (filePath: string, importPath: string): string | null => {
	if (!importPath.startsWith('.')) return null;
	return path.resolve(path.dirname(filePath), importPath);
};

export default async function checkLayerBoundaries(): Promise<void> {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts) as ContextConfig[];

	if (!contexts.length) {
		console.error('❌ No contexts found in azure-net.config.ts/js. Fill `contexts` first.');
		process.exitCode = 1;
		return;
	}

	const sharedAliasRaw = normalizeAlias(config.sharedAlias, '');
	const sharedAlias = sharedAliasRaw.length ? sharedAliasRaw : null;
	if (!sharedAlias) {
		console.error('❌ sharedAlias is missing in azure-net.config.ts/js. Set it explicitly to the shared context alias.');
		process.exitCode = 1;
		return;
	}

	const aliasToContext = new Map<string, ContextConfig>();
	for (const context of contexts) {
		aliasToContext.set(context.alias, context);
	}

	const knownAliases = [...contexts.map((context) => context.alias)];
	const sharedContext = aliasToContext.get(sharedAlias);
	if (!sharedContext) {
		console.error(`❌ sharedAlias "${sharedAlias}" does not point to any configured context.`);
		process.exitCode = 1;
		return;
	}

	const issues: BoundaryIssue[] = [];

	for (const context of contexts) {
		const contextRoot = path.join(process.cwd(), 'src', 'app', context.name);
		const isSharedContext = context.alias === sharedAlias;
		const sharedEssentialsRoot = isSharedContext ? path.join(contextRoot, SHARED_ESSENTIALS_DIR_NAME) : null;

		try {
			await fs.access(contextRoot);
		} catch {
			continue;
		}

		const files = await listFiles(contextRoot);
		const allowedAliases = new Set<string>([context.alias]);
		if (context.alias !== sharedAlias) {
			allowedAliases.add(sharedAlias);
		}

		for (const filePath of files) {
			const content = await fs.readFile(filePath, 'utf-8');
			const imports = extractImports(content);
			const isSharedEssentialsFile = Boolean(sharedEssentialsRoot && isInside(filePath, sharedEssentialsRoot));

			for (const entry of imports) {
				const targetAlias = resolveAliasFromImport(entry.value, knownAliases);
				if (!targetAlias) continue;

				if (isSharedEssentialsFile && targetAlias === sharedAlias) {
					const importRest = entry.value.slice(sharedAlias.length).replace(/^\/+/, '');
					if (importRest.length && !importRest.startsWith(`${SHARED_ESSENTIALS_DIR_NAME}/`)) {
						issues.push({
							file: filePath,
							line: entry.line,
							message: `Layer boundary violation: shared essentials cannot import from shared "${importRest}". Essentials may depend only on shared essentials code.`
						});
						continue;
					}
				}

				if (allowedAliases.has(targetAlias)) continue;

				const targetContext = aliasToContext.get(targetAlias);
				const baseMessage = targetContext
					? `Layer boundary violation: context "${context.name}" cannot import from context "${targetContext.name}" (${targetAlias})`
					: `Layer boundary violation: context "${context.name}" cannot import from "${targetAlias}"`;

				issues.push({
					file: filePath,
					line: entry.line,
					message: baseMessage
				});
			}

			for (const entry of imports) {
				const absoluteRelativeImport = resolveAbsoluteRelativeImport(filePath, entry.value);
				if (
					isSharedEssentialsFile &&
					absoluteRelativeImport &&
					sharedEssentialsRoot &&
					isInside(absoluteRelativeImport, contextRoot) &&
					!isInside(absoluteRelativeImport, sharedEssentialsRoot)
				) {
					issues.push({
						file: filePath,
						line: entry.line,
						message: 'Layer boundary violation: shared essentials cannot import from shared layers/ui via relative path.'
					});
					continue;
				}

				const relativeTargetContext = resolveContextFromRelativeImport(filePath, entry.value, contexts);
				if (!relativeTargetContext || relativeTargetContext.name === context.name) continue;
				if (context.alias !== sharedAlias && relativeTargetContext.alias === sharedAlias) continue;

				const baseMessage = `Layer boundary violation: context "${context.name}" cannot import from context "${relativeTargetContext.name}" via relative path`;

				issues.push({
					file: filePath,
					line: entry.line,
					message: baseMessage
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
