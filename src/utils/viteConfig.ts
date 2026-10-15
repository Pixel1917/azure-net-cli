import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { format, resolveConfig } from 'prettier';
import { mergeAliasesInSvelteConfig } from './legacyAliases.js';
import { ARCHITECTURE_ALIASES } from './architecture.js';

export const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];
export const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs'];
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const parse = (text: string) => ts.createSourceFile('config.ts', text, ts.ScriptTarget.Latest, true);
const name = (node: ts.Node | undefined): string | undefined =>
	node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
function object(expression: ts.Expression, source: ts.SourceFile, seen = new Set<string>()): ts.ObjectLiteralExpression {
	if (ts.isObjectLiteralExpression(expression)) return expression;
	if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
		return object(expression.expression, source, seen);
	if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
		seen.add(expression.text);
		for (const statement of source.statements)
			if (ts.isVariableStatement(statement))
				for (const d of statement.declarationList.declarations)
					if (name(d.name) === expression.text && d.initializer) return object(d.initializer, source, seen);
	}
	throw new Error('Cannot safely edit dynamic SvelteKit options. Use an object literal or a local object variable in sveltekit().');
}
function kitCall(source: ts.SourceFile): ts.CallExpression {
	const names = new Set<string>();
	for (const s of source.statements)
		if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === '@sveltejs/kit/vite') {
			const b = s.importClause?.namedBindings;
			if (b && ts.isNamedImports(b))
				for (const e of b.elements) if ((e.propertyName?.text ?? e.name.text) === 'sveltekit') names.add(e.name.text);
		}
	const calls: ts.CallExpression[] = [];
	const visit = (n: ts.Node): void => {
		if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) calls.push(n);
		ts.forEachChild(n, visit);
	};
	visit(source);
	if (calls.length !== 1) throw new Error('Expected exactly one imported sveltekit() call in vite.config. No files changed.');
	return calls[0]!;
}
function modernOptions(input: ts.ObjectLiteralExpression, source: ts.SourceFile): string {
	const has = (obj: ts.ObjectLiteralExpression, key: string) => obj.properties.some((p) => name(p.name) === key);
	const nestedHas = (key: string, keys: string[]) => {
		const property = input.properties.find((p) => name(p.name) === key);
		if (!property || !ts.isPropertyAssignment(property)) return false;
		const value = objectOrUndefined(property.initializer, source);
		return value && keys.some((k) => has(value, k));
	};
	if (
		!['kit', 'vitePlugin', 'preloadStrategy'].some((k) => has(input, k)) &&
		!nestedHas('files', ['lib']) &&
		!nestedHas('experimental', ['handleRenderingErrors', 'instrumentation', 'tracing']) &&
		!nestedHas('prerender', ['origin']) &&
		!nestedHas('csrf', ['checkOrigin'])
	)
		return input.getText(source);
	const print = (n: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, n, source);
	const props = [...input.properties];
	const take = (items: ts.ObjectLiteralElementLike[], key: string): ts.Expression | undefined => {
		const found = items.findIndex((p) => name(p.name) === key);
		if (found < 0) return;
		const p = items.splice(found, 1)[0]!;
		if (!ts.isPropertyAssignment(p)) throw new Error(`Cannot safely convert option ${key}`);
		return p.initializer;
	};
	const set = (items: ts.ObjectLiteralElementLike[], key: string, value: ts.Expression) => {
		if (items.some((p) => name(p.name) === key)) throw new Error(`Conflicting SvelteKit option ${key}; resolve manually.`);
		items.push(ts.factory.createPropertyAssignment(key, value));
	};
	const nested = (key: string, edit: (items: ts.ObjectLiteralElementLike[]) => void) => {
		const value = take(props, key);
		if (!value) return;
		const items = [...object(value, source).properties];
		edit(items);
		if (items.length) set(props, key, ts.factory.createObjectLiteralExpression(items, true));
	};
	const oldKit = take(props, 'kit');
	if (oldKit)
		for (const p of object(oldKit, source).properties) {
			if (props.some((existing) => name(existing.name) && name(existing.name) === name(p.name)))
				throw new Error(`Conflicting option ${name(p.name)}`);
			props.push(p);
		}
	const vitePlugin = take(props, 'vitePlugin');
	if (vitePlugin)
		for (const p of object(vitePlugin, source).properties) {
			if (props.some((existing) => name(existing.name) && name(existing.name) === name(p.name)))
				throw new Error(`Conflicting option ${name(p.name)}`);
			props.push(p);
		}
	take(props, 'preloadStrategy');
	nested('files', (items) => {
		take(items, 'lib');
	});
	nested('experimental', (items) => {
		take(items, 'handleRenderingErrors');
		take(items, 'instrumentation');
		const tracing = take(items, 'tracing');
		if (tracing) set(props, 'tracing', tracing);
	});
	let origin: ts.Expression | undefined;
	nested('prerender', (items) => {
		origin = take(items, 'origin');
	});
	if (origin) {
		const paths = take(props, 'paths');
		const items = paths ? [...object(paths, source).properties] : [];
		set(items, 'origin', origin);
		set(props, 'paths', ts.factory.createObjectLiteralExpression(items, true));
	}
	nested('csrf', (items) => {
		const check = take(items, 'checkOrigin');
		if (!check) return;
		if (check.kind === ts.SyntaxKind.FalseKeyword) {
			if (items.some((p) => name(p.name) === 'trustedOrigins')) throw new Error('Resolve csrf.checkOrigin and trustedOrigins manually.');
			set(items, 'trustedOrigins', ts.factory.createArrayLiteralExpression([ts.factory.createStringLiteral('*')]));
		} else if (check.kind !== ts.SyntaxKind.TrueKeyword) throw new Error('Dynamic csrf.checkOrigin requires manual migration.');
	});
	return print(ts.factory.createObjectLiteralExpression(props, true));
}

/** Pure config edit; never evaluates a project's configuration. */
export function mergeKitViteConfig(content: string, aliases: Record<string, string>, legacy?: string): string {
	let source = parse(content);
	const call = kitCall(source);
	let options = call.arguments[0] ? object(call.arguments[0], source) : undefined;
	let optionText = options ? modernOptions(options, source) : '{}';
	if (legacy) {
		if (options && options.properties.length)
			throw new Error('Both Vite and legacy Svelte config contain options. Merge them with sv migrate sveltekit-3 first.');
		const old = parse(legacy),
			exported = old.statements.find(ts.isExportAssignment);
		if (!exported) throw new Error('Legacy Svelte config has no default export.');
		const root = object(exported.expression, old);
		optionText = modernOptions(root, old);
		const imports = old.statements.filter(ts.isImportDeclaration);
		const bindings = (s: ts.SourceFile) => {
			const names = new Set<string>();
			for (const n of s.statements) {
				if (ts.isImportDeclaration(n)) {
					if (n.importClause?.name) names.add(n.importClause.name.text);
					const b = n.importClause?.namedBindings;
					if (b && ts.isNamespaceImport(b)) names.add(b.name.text);
					if (b && ts.isNamedImports(b)) for (const e of b.elements) names.add(e.name.text);
				}
				if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
			}
			return names;
		};
		const oldNames = bindings(old);
		const currentNames = bindings(source);
		for (const n of oldNames) if (currentNames.has(n)) throw new Error(`Config binding collision: ${n}. Run sv migrate sveltekit-3 first.`);
		const rootStatement = old.statements.find(
			(s) =>
				ts.isVariableStatement(s) &&
				s.declarationList.declarations.some((d) => d.initializer && objectOrUndefined(d.initializer, old) === root)
		);
		if (rootStatement && ts.isVariableStatement(rootStatement) && rootStatement.declarationList.declarations.length !== 1)
			throw new Error('Split legacy config variable declarations before migration.');
		for (const statement of old.statements)
			if (
				!ts.isImportDeclaration(statement) &&
				!ts.isExportAssignment(statement) &&
				statement !== rootStatement &&
				!ts.isEmptyStatement(statement)
			)
				throw new Error('Complex legacy config: run sv migrate sveltekit-3 first.');
		const importText = imports.map((s) => s.getText(old)).join('\n');
		content = content.slice(0, call.arguments.pos) + optionText + content.slice(call.arguments.end);
		content = importText + '\n' + content;
		source = parse(content);
		const updated = kitCall(source);
		options = object(updated.arguments[0]!, source);
	}
	const synthetic = mergeAliasesInSvelteConfig(`export default { kit: ${optionText} };`, aliases);
	const merged = parse(synthetic).statements.find(ts.isExportAssignment)!;
	const kit = (merged.expression as ts.ObjectLiteralExpression).properties[0] as ts.PropertyAssignment;
	const replacement = kit.initializer.getText(merged.getSourceFile());
	if (options) return content.slice(0, options.getStart(source)) + replacement + content.slice(options.end);
	const actual = kitCall(source);
	return content.slice(0, actual.arguments.pos) + replacement + content.slice(actual.arguments.end);
}
function objectOrUndefined(e: ts.Expression, source: ts.SourceFile) {
	try {
		return object(e, source);
	} catch {
		return undefined;
	}
}
export async function formatConfig(content: string, file: string): Promise<string> {
	return format(content, { ...(await resolveConfig(file)), filepath: file, parser: 'typescript' });
}
export async function configureKitProject(): Promise<void> {
	const root = process.cwd();
	const existing = async (names: string[]) => {
		for (const n of names) {
			try {
				await fs.access(path.join(root, n));
				return path.join(root, n);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
	};
	const vite = await existing(VITE_CONFIGS),
		legacy = await existing(SVELTE_CONFIGS);
	if (!vite && !legacy) {
		console.warn('No Vite config found; initialize a SvelteKit project first.');
		return;
	}
	const file = vite ?? path.join(root, 'vite.config.ts');
	const content = vite
		? await fs.readFile(vite, 'utf8')
		: "import { defineConfig } from 'vite';\nimport { sveltekit } from '@sveltejs/kit/vite';\nexport default defineConfig({plugins: [sveltekit()]});\n";
	const old = legacy ? await fs.readFile(legacy, 'utf8') : undefined;
	const next = await formatConfig(mergeKitViteConfig(content, ARCHITECTURE_ALIASES, old), file);
	if (legacy) {
		const backup = await fs.mkdtemp(
			path.join(
				await fs
					.mkdir(path.join(root, '.azure-net/ConfigBackups'), { recursive: true })
					.then(() => path.join(root, '.azure-net/ConfigBackups')),
				'kit3-'
			)
		);
		await fs.writeFile(path.join(backup, path.basename(legacy)), old!);
		if (vite) await fs.writeFile(path.join(backup, path.basename(vite)), content);
	}
	await fs.writeFile(file, next);
	if (legacy) await fs.unlink(legacy);
}

export function readStaticAliases(content: string): Record<string, string> {
	const aliases: Record<string, string> = {};
	const source = parse(content);
	const visit = (n: ts.Node): void => {
		if (ts.isPropertyAssignment(n) && name(n.name) === 'alias') {
			const value = objectOrUndefined(n.initializer, source);
			if (value)
				for (const p of value.properties)
					if (ts.isPropertyAssignment(p) && name(p.name) && ts.isStringLiteral(p.initializer)) aliases[name(p.name)!] = p.initializer.text;
		}
		ts.forEachChild(n, visit);
	};
	visit(source);
	return aliases;
}

/** Hydratable needs Svelte async mode. Preserve all unrelated literal options. */
export function enableHydratable(content: string): string {
	const source = parse(content);
	const call = kitCall(source);
	const update = (value: ts.ObjectLiteralExpression, keys: string[]): ts.ObjectLiteralExpression => {
		const key = keys[0]!;
		const props = [...value.properties];
		const existing = props.find((p) => name(p.name) === key);
		if (existing && !ts.isPropertyAssignment(existing))
			throw new Error(`Cannot safely configure ${keys.join('.')}. Use literal compilerOptions.`);
		if (props.some(ts.isSpreadAssignment))
			throw new Error('Cannot safely enable async mode in spread options. Set compilerOptions.experimental.async: true manually.');
		const next =
			keys.length === 1
				? ts.factory.createTrue()
				: update(
						existing ? object((existing as ts.PropertyAssignment).initializer, source) : ts.factory.createObjectLiteralExpression(),
						keys.slice(1)
					);
		const index = props.findIndex((p) => name(p.name) === key);
		const property = ts.factory.createPropertyAssignment(key, next);
		if (index === -1) props.push(property);
		else props[index] = property;
		return ts.factory.createObjectLiteralExpression(props, true);
	};
	const options = call.arguments[0] ? object(call.arguments[0], source) : ts.factory.createObjectLiteralExpression();
	const updated = update(options, ['compilerOptions', 'experimental', 'async']);
	return (
		content.slice(0, call.getStart(source)) +
		`${call.expression.getText(source)}(${ts.createPrinter().printNode(ts.EmitHint.Expression, updated, source)})` +
		content.slice(call.end)
	);
}
