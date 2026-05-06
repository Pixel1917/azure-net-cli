import fs from 'node:fs/promises';
import path from 'node:path';
const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);
const IMPORT_DECLARATION_PATTERN = /(^|\n)\s*import\s+(?:[\s\S]*?\s+from\s*)?['"]([^'"]+)['"]\s*;?/g;
const EXPORT_DECLARATION_PATTERN = /(^|\n)\s*export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)['"]([^'"]+)['"]\s*;?/g;
const FORBIDDEN_IMPORT_EXTENSION_PATTERN = /\.(?:ts|js)(?:$|[?#])/;
const toPosixPath = (value) => value.split(path.sep).join('/');
const getRelativePath = (filePath) => toPosixPath(path.relative(process.cwd(), filePath));
const findLineByIndex = (content, index) => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};
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
const getImportKind = (raw) => {
	const normalized = raw.trim();
	if (/^import\s+type\b/.test(normalized)) return 'type';
	if (/^import\s*['"]/.test(normalized)) return 'side-effect';
	return 'value';
};
const getKindOrder = (kind) => {
	if (kind === 'value') return 0;
	if (kind === 'type') return 1;
	return 2;
};
const extractImports = (content) => {
	const imports = [];
	const regex = new RegExp(IMPORT_DECLARATION_PATTERN.source, 'g');
	let match;
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
const extractExportSources = (content) => {
	const exports = [];
	const regex = new RegExp(EXPORT_DECLARATION_PATTERN.source, 'g');
	let match;
	while ((match = regex.exec(content)) !== null) {
		const source = match[2];
		if (!source) continue;
		exports.push({
			source,
			line: findLineByIndex(content, match.index + (match[1] === '\n' ? 1 : 0))
		});
	}
	return exports;
};
const hasForbiddenExtension = (source) => {
	const sourceWithoutQuery = source.split('?')[0] ?? source;
	return FORBIDDEN_IMPORT_EXTENSION_PATTERN.test(sourceWithoutQuery);
};
const collectIssuesForFile = (filePath, content) => {
	const issues = [];
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
	for (const exportEntry of extractExportSources(content)) {
		if (!hasForbiddenExtension(exportEntry.source)) continue;
		issues.push({
			file: filePath,
			line: exportEntry.line,
			message: `Export source "${exportEntry.source}" must not include .ts/.js extension`
		});
	}
	return issues;
};
export default async function checkImports() {
	const srcRoot = path.join(process.cwd(), 'src');
	try {
		await fs.access(srcRoot);
	} catch {
		console.error('❌ src folder not found.');
		process.exitCode = 1;
		return;
	}
	const issues = [];
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
//# sourceMappingURL=checkImports.js.map
