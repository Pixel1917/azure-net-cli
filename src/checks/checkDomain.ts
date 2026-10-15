import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { appRoot, directories, exportOnly, parseSource } from './architecture.js';

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
const IGNORED_DIRS = new Set(['.backup', 'node_modules', 'dist', '.svelte-kit', '.git']);

const toPosixPath = (value: string): string => value.split(path.sep).join('/');

const getRelativeFilePath = (filePath: string): string => toPosixPath(path.relative(process.cwd(), filePath));

const isIndexFile = (filePath: string): boolean => path.basename(filePath) === 'index.ts';

const startsWithInterfacePrefix = (filePath: string): boolean => /^I[A-Z]/.test(path.basename(filePath, '.ts'));

const isExportOnlyIndex = exportOnly;

const validateName = (declaration: Declaration): string | null => {
	if (declaration.kind === 'interface') {
		return /^I[A-Z]/.test(declaration.name) ? null : `Interface "${declaration.name}" must start with "I" and have uppercase second letter`;
	}

	return /^[IT][A-Z]/.test(declaration.name)
		? null
		: `Type "${declaration.name}" must start with "I" or "T" and have uppercase second letter`;
};

const extractDeclarations = (content: string): Declaration[] => {
	const source = parseSource(content);
	const declarations: Declaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
			declarations.push({
				kind: ts.isInterfaceDeclaration(node) ? 'interface' : 'type',
				name: node.name.text,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
			});
		ts.forEachChild(node, visit);
	};
	visit(source);
	return declarations;
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

	if (!isIndexFile(filePath) && startsWithInterfacePrefix(filePath)) {
		issues.push({
			file: filePath,
			line: 1,
			message: 'Domain file names must not start with "I". Keep "I" only in interface/type names'
		});
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
	const issues: DomainIssue[] = [];
	let contexts: string[];
	try {
		contexts = await directories(path.join(appRoot(), 'Contexts'));
	} catch {
		console.error('Contexts folder not found in src/app.');
		process.exitCode = 1;
		return;
	}

	for (const context of contexts) {
		const domainRoot = path.join(appRoot(), 'Contexts', context, 'Domain');

		try {
			await fs.access(domainRoot);
		} catch {
			issues.push({
				file: domainRoot,
				line: 1,
				message: `Domain folder not found for context "${context}"`
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
