import { resolvePackageImport } from '../utils/packageImports.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readStaticAliases, VITE_CONFIGS, SVELTE_CONFIGS } from '../utils/viteConfig.js';
import ts from 'typescript';

export type Issue = { file: string; line: number; message: string };
export const appRoot = (): string => path.join(process.cwd(), 'src', 'app');
export const directories = async (root: string): Promise<string[]> =>
	(await fs.readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name !== '.backup')
		.map((entry) => entry.name);
export async function sourceFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (['.backup', 'node_modules', '.git', '.svelte-kit', 'dist'].includes(entry.name)) continue;
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
		else if (/\.(?:[cm]?[jt]sx?|svelte)$/.test(entry.name)) files.push(file);
	}
	return files;
}

export function parseSource(content: string, filename = 'Source.ts'): ts.SourceFile {
	// Mask markup while retaining offsets for accurate Svelte script diagnostics.
	if (filename.endsWith('.svelte')) {
		const pieces: string[] = [];
		let end = 0;
		const scripts = /<!--[^]*?-->|<script\b[^>]*>([^]*?)<\/script\s*>/gi;
		for (const match of content.matchAll(scripts)) {
			if (match[1] === undefined) continue;
			const start = match.index + match[0].indexOf('>') + 1;
			pieces.push(content.slice(end, start).replace(/[^\r\n]/g, ' '), match[1]);
			end = start + match[1].length;
		}
		pieces.push(content.slice(end).replace(/[^\r\n]/g, ' '));
		content = pieces.join('');
	}
	return ts.createSourceFile(
		filename,
		content,
		ts.ScriptTarget.Latest,
		true,
		/\.[jt]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
}

export function dependencies(content: string, filename = 'Source.ts'): Array<{ source: string; line: number; kind: string }> {
	const result: Array<{ source: string; line: number; kind: string }> = [];
	const sourceFile = parseSource(content, filename);
	const add = (literal: ts.Node | undefined, node: ts.Node, kind: string): void => {
		if (!literal || (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal))) return;
		result.push({ source: literal.text, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, kind });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			const inlineTypes =
				!clause?.name &&
				bindings &&
				ts.isNamedImports(bindings) &&
				bindings.elements.length > 0 &&
				bindings.elements.every((element) => element.isTypeOnly);
			add(node.moduleSpecifier, node, !clause ? 'side-effect' : clause.isTypeOnly || inlineTypes ? 'type' : 'value');
		} else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, node, 'export');
		else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], node, 'dynamic');
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, node, 'dynamic');
		else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
			add(node.moduleReference.expression, node, node.isTypeOnly ? 'type' : 'value');
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return result;
}

export function exportOnly(content: string): boolean {
	return parseSource(content).statements.every((node) => ts.isExportDeclaration(node) || ts.isEmptyStatement(node));
}

export async function importResolver(): Promise<(file: string, source: string) => string | null> {
	const aliases: Record<string, string> = {
		'#contexts': 'src/app/Contexts',
		'#presentation': 'src/app/Presentation',
		'#platform': 'src/app/Platform',
		$lib: 'src/lib',
		'#lib': 'src/lib'
	};
	for (const name of [...VITE_CONFIGS, ...SVELTE_CONFIGS]) {
		const configPath = path.join(process.cwd(), name);
		try {
			await fs.access(configPath);
		} catch {
			continue;
		}
		Object.assign(aliases, readStaticAliases(await fs.readFile(configPath, 'utf8')));
		break;
	}
	let imports: Record<string, unknown> = {};
	try {
		imports = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')).imports ?? {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const entries = Object.entries(aliases).sort(([a], [b]) => b.length - a.length);
	return (file, source) => {
		const clean = source[0]! + source.slice(1).split(/[?#]/)[0]!;
		const imported = resolvePackageImport(imports, clean, process.cwd());
		if (imported) return imported;
		if (clean.startsWith('.')) return path.resolve(path.dirname(file), clean);
		if (path.isAbsolute(clean)) return path.resolve(clean);
		for (const [key, target] of entries) {
			const alias = key.replace(/\/\*$/, '');
			if (clean !== alias && !clean.startsWith(`${alias}/`)) continue;
			return path.resolve(process.cwd(), target.replace(/\/\*$/, ''), clean.slice(alias.length).replace(/^\//, ''));
		}
		return null;
	};
}

export function location(file: string): string[] {
	return path.relative(appRoot(), file).split(path.sep);
}
export function report(label: string, issues: Issue[]): void {
	if (!issues.length) {
		console.log(`${label} check passed.`);
		return;
	}
	console.error(`${label} check failed:`);
	for (const issue of issues) console.error(`${path.relative(process.cwd(), issue.file)}:${issue.line} - ${issue.message}`);
	process.exitCode = 1;
}
export async function checkDependencies(label: string, rule: (source: string[], target: string[]) => string | null): Promise<void> {
	const issues: Issue[] = [];
	try {
		const resolve = await importResolver();
		for (const file of await sourceFiles(appRoot())) {
			for (const entry of dependencies(await fs.readFile(file, 'utf8'), file)) {
				const target = resolve(file, entry.source);
				if (!target) continue;
				const message = rule(location(file), location(target));
				if (message) issues.push({ file, line: entry.line, message: `${message} (${entry.source})` });
			}
		}
	} catch (error) {
		issues.push({ file: appRoot(), line: 1, message: String(error) });
	}
	report(label, issues);
}
