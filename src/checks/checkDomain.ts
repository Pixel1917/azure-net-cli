import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';

type DomainIssue = {
	file: string;
	line: number;
	message: string;
};

type Declaration = {
	kind: 'interface' | 'type';
	name: string;
	line: number;
};

const DOMAIN_FILE_EXTENSIONS = new Set(['.ts']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);

const INTERFACE_DECLARATION_PATTERN = /(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
const TYPE_DECLARATION_PATTERN = /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;

const EXPORT_STAR_PATTERN = /export\s+\*\s+from\s*['"][^'"]+['"]\s*;?/g;
const EXPORT_FROM_PATTERN = /export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s*['"][^'"]+['"]\s*;?/g;
const EXPORT_LOCAL_PATTERN = /export\s+(?:type\s+)?\{[\s\S]*?\}\s*;?/g;

const toPosixPath = (value: string): string => value.split(path.sep).join('/');

const stripComments = (content: string): string => content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\])\/\/.*$/gm, '$1');

const stripExportStatements = (content: string): string =>
	content.replace(EXPORT_STAR_PATTERN, '').replace(EXPORT_FROM_PATTERN, '').replace(EXPORT_LOCAL_PATTERN, '');

const findLineByIndex = (content: string, index: number): number => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};

const getRelativeFilePath = (filePath: string): string => toPosixPath(path.relative(process.cwd(), filePath));

const isEnumsPath = (filePath: string): boolean => {
	const normalized = toPosixPath(filePath);
	return normalized.includes('/enums/');
};

const isIndexFile = (filePath: string): boolean => path.basename(filePath) === 'index.ts';

const isExportOnlyIndex = (content: string): boolean => {
	const withoutComments = stripComments(content);
	const withoutExports = stripExportStatements(withoutComments);
	return withoutExports.trim().length === 0;
};

const validateName = (declaration: Declaration): string | null => {
	if (declaration.kind === 'interface') {
		return /^I[A-Z]/.test(declaration.name) ? null : `Interface "${declaration.name}" must start with "I" and have uppercase second letter`;
	}

	return /^[IT][A-Z]/.test(declaration.name)
		? null
		: `Type "${declaration.name}" must start with "I" or "T" and have uppercase second letter`;
};

const extractDeclarations = (content: string): Declaration[] => {
	const cleaned = stripComments(content);
	const declarations: Declaration[] = [];

	const interfaceRegex = new RegExp(INTERFACE_DECLARATION_PATTERN.source, 'g');
	let interfaceMatch: RegExpExecArray | null;
	while ((interfaceMatch = interfaceRegex.exec(cleaned)) !== null) {
		const name = interfaceMatch[1];
		if (!name) continue;
		declarations.push({
			kind: 'interface',
			name,
			line: findLineByIndex(cleaned, interfaceMatch.index)
		});
	}

	const typeRegex = new RegExp(TYPE_DECLARATION_PATTERN.source, 'g');
	let typeMatch: RegExpExecArray | null;
	while ((typeMatch = typeRegex.exec(cleaned)) !== null) {
		const name = typeMatch[1];
		if (!name) continue;
		declarations.push({
			kind: 'type',
			name,
			line: findLineByIndex(cleaned, typeMatch.index)
		});
	}

	return declarations.sort((a, b) => a.line - b.line);
};

const listDomainFiles = async (domainRoot: string): Promise<string[]> => {
	const files: string[] = [];
	const stack: string[] = [domainRoot];

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
			if (!DOMAIN_FILE_EXTENSIONS.has(path.extname(filePath))) continue;
			files.push(filePath);
		}
	}

	return files;
};

const collectIssuesForFile = (filePath: string, content: string): DomainIssue[] => {
	const issues: DomainIssue[] = [];

	if (isIndexFile(filePath) && !isExportOnlyIndex(content)) {
		issues.push({
			file: filePath,
			line: 1,
			message: 'index.ts must contain only exports. Move declarations to separate files'
		});
	}

	if (isEnumsPath(filePath)) {
		return issues;
	}

	const declarations = extractDeclarations(content);
	if (declarations.length > 5) {
		issues.push({
			file: filePath,
			line: declarations[5]?.line ?? 1,
			message: `Too many declarations in one file (${declarations.length}). Maximum is 5`
		});
	}

	for (const declaration of declarations) {
		const validationError = validateName(declaration);
		if (!validationError) continue;
		issues.push({
			file: filePath,
			line: declaration.line,
			message: validationError
		});
	}

	return issues;
};

export default async function checkDomain(): Promise<void> {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);

	if (!contexts.length) {
		console.error('❌ No contexts found in azure-net.config.ts/js. Fill `contexts` first.');
		process.exitCode = 1;
		return;
	}

	const issues: DomainIssue[] = [];

	for (const context of contexts) {
		const domainRoot = path.join(process.cwd(), 'src', 'app', context.name, 'layers', 'domain');

		try {
			await fs.access(domainRoot);
		} catch {
			issues.push({
				file: domainRoot,
				line: 1,
				message: `Domain folder not found for context "${context.name}"`
			});
			continue;
		}

		const files = await listDomainFiles(domainRoot);
		for (const filePath of files) {
			const content = await fs.readFile(filePath, 'utf-8');
			issues.push(...collectIssuesForFile(filePath, content));
		}
	}

	if (!issues.length) {
		console.log('✅ Domain check passed: naming, per-file limits and index exports are valid.');
		return;
	}

	console.error('❌ Domain check failed:');
	for (const issue of issues) {
		console.error(`• ${getRelativeFilePath(issue.file)}:${issue.line} — ${issue.message}`);
	}

	process.exitCode = 1;
}
