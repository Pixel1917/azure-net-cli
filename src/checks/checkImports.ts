import fs from 'node:fs/promises';
import path from 'node:path';

type ImportIssue = {
	file: string;
	line: number;
	message: string;
};

type ImportKind = 'value' | 'type' | 'side-effect';

type ImportEntry = {
	kind: ImportKind;
	line: number;
	source: string;
	raw: string;
};

const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);
const IMPORT_DECLARATION_PATTERN = /(^|\n)\s*import\s+(?:[\s\S]*?\s+from\s*)?['"]([^'"]+)['"]\s*;?/g;
const FORBIDDEN_IMPORT_EXTENSION_PATTERN = /\.(?:ts|js)$/;

const toPosixPath = (value: string): string => value.split(path.sep).join('/');

const getRelativePath = (filePath: string): string => toPosixPath(path.relative(process.cwd(), filePath));

const findLineByIndex = (content: string, index: number): number => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};

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

const getImportKind = (raw: string): ImportKind => {
	const normalized = raw.trim();
	if (/^import\s+type\b/.test(normalized)) return 'type';
	if (/^import\s*['"]/.test(normalized)) return 'side-effect';
	return 'value';
};

const getKindOrder = (kind: ImportKind): number => {
	if (kind === 'value') return 0;
	if (kind === 'type') return 1;
	return 2;
};

const extractImports = (content: string): ImportEntry[] => {
	const imports: ImportEntry[] = [];
	const regex = new RegExp(IMPORT_DECLARATION_PATTERN.source, 'g');
	let match: RegExpExecArray | null;

	while ((match = regex.exec(content)) !== null) {
		const raw = match[0].trim();
		const source = match[2];
		if (!source) continue;

		imports.push({
			kind: getImportKind(raw),
			line: findLineByIndex(content, match.index + (match[1] === '\n' ? 1 : 0)),
			source,
			raw
		});
	}

	return imports.sort((a, b) => a.line - b.line);
};

const hasForbiddenExtension = (source: string): boolean => {
	const sourceWithoutQuery = source.split('?')[0] ?? source;
	return FORBIDDEN_IMPORT_EXTENSION_PATTERN.test(sourceWithoutQuery);
};

const collectIssuesForFile = (filePath: string, content: string): ImportIssue[] => {
	const issues: ImportIssue[] = [];
	const imports = extractImports(content);
	let lastKindOrder = 0;

	for (const importEntry of imports) {
		if (hasForbiddenExtension(importEntry.source)) {
			issues.push({
				file: filePath,
				line: importEntry.line,
				message: `Import "${importEntry.source}" must not include .ts/.js extension`
			});
		}

		const currentOrder = getKindOrder(importEntry.kind);
		if (currentOrder < lastKindOrder) {
			issues.push({
				file: filePath,
				line: importEntry.line,
				message: 'Import order violation: value imports first, then type imports, then side-effect imports'
			});
		}
		lastKindOrder = Math.max(lastKindOrder, currentOrder);
	}

	return issues;
};

export default async function checkImports(): Promise<void> {
	const srcRoot = path.join(process.cwd(), 'src');

	try {
		await fs.access(srcRoot);
	} catch {
		console.error('❌ src folder not found.');
		process.exitCode = 1;
		return;
	}

	const issues: ImportIssue[] = [];
	const files = await listFiles(srcRoot);

	for (const filePath of files) {
		const content = await fs.readFile(filePath, 'utf-8');
		issues.push(...collectIssuesForFile(filePath, content));
	}

	if (!issues.length) {
		console.log('✅ Imports check passed: extensions and import groups are valid.');
		return;
	}

	console.error('❌ Imports check failed:');
	for (const issue of issues) {
		console.error(`• ${getRelativePath(issue.file)}:${issue.line} — ${issue.message}`);
	}

	process.exitCode = 1;
}
