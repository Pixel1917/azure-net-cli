import path from 'node:path';
import ts from 'typescript';
type Edit = { start: number; end: number; text: string };
const patch = (input: string, edits: Edit[]) => {
	for (const e of edits.sort((a, b) => b.start - a.start)) input = input.slice(0, e.start) + e.text + input.slice(e.end);
	return input;
};
const internal = new Set(['preloadTranslation', 'initializeClient', 'syncFromState']);
const translationModules = new Set(['@azure-net/kit/i18n', '@azure-net/edges-translations']);

/** A conservative migration of known translation wiring, never a project-wide textual replacement. */
export function migrateTranslationsSources(sources: Map<string, string>, resolve: (from: string, specifier: string) => string | undefined) {
	const updates = new Map<string, string>();
	const issues: { file: string; reason: string }[] = [];
	const managers: { file: string; name: string }[] = [];
	for (const [file, input] of sources) {
		if (!/\.[jt]s$/.test(file)) continue;
		const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
		const factories = new Set<string>();
		for (const stmt of source.statements) {
			if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !translationModules.has(stmt.moduleSpecifier.text))
				continue;
			const bindings = stmt.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings))
				for (const b of bindings.elements) if ((b.propertyName ?? b.name).text === 'createTranslations') factories.add(b.name.text);
		}
		for (const stmt of source.statements)
			if (ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
				for (const d of stmt.declarationList.declarations) {
					if (
						ts.isIdentifier(d.name) &&
						d.initializer &&
						ts.isCallExpression(d.initializer) &&
						ts.isIdentifier(d.initializer.expression) &&
						factories.has(d.initializer.expression.text)
					)
						managers.push({ file, name: d.name.text });
				}
	}
	if (!managers.length) return { updates, issues };
	if (managers.length !== 1) {
		for (const m of managers)
			issues.push({ file: m.file, reason: 'Multiple translation managers: choose the manager for app.useTranslations manually.' });
		return { updates, issues };
	}
	const manager = managers[0]!;
	const reaches = (file: string, seen = new Set<string>()): boolean => {
		if (file === manager.file) return true;
		if (seen.has(file)) return false;
		seen.add(file);
		const source = ts.createSourceFile(file, sources.get(file) ?? '', ts.ScriptTarget.Latest, true);
		return source.statements.some((s) => {
			if ((!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) || !s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier))
				return false;
			const target = resolve(file, s.moduleSpecifier.text);
			return !!target && reaches(target, seen);
		});
	};
	let connected = false;
	for (const [file, input] of sources) {
		if (!/\.[jt]s$/.test(file) || !reaches(file)) continue;
		const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
		const creators = new Set<string>();
		for (const stmt of source.statements)
			if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text === '@azure-net/kit') {
				const b = stmt.importClause?.namedBindings;
				if (b && ts.isNamedImports(b))
					for (const e of b.elements) if ((e.propertyName ?? e.name).text === 'createApp') creators.add(e.name.text);
			}
		const calls: ts.CallExpression[] = [];
		const visit = (n: ts.Node): void => {
			if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && creators.has(n.expression.text)) calls.push(n);
			ts.forEachChild(n, visit);
		};
		visit(source);
		if (!calls.length) continue;
		if (calls.length !== 1) {
			issues.push({ file, reason: 'Multiple createApp calls: connect translations manually.' });
			continue;
		}
		const callback = calls[0]!.arguments[0];
		if (!callback || !ts.isArrowFunction(callback) || !callback.parameters[0] || !ts.isIdentifier(callback.parameters[0].name)) {
			issues.push({ file, reason: 'Unsupported createApp callback: add useTranslations manually.' });
			continue;
		}
		let body: ts.Expression | undefined = ts.isBlock(callback.body)
			? callback.body.statements.find(ts.isReturnStatement)?.expression
			: callback.body;
		let already = false;
		while (body && ts.isCallExpression(body) && ts.isPropertyAccessExpression(body.expression)) {
			if (body.expression.name.text === 'useTranslations') already = true;
			body = body.expression.expression;
		}
		if (already) {
			connected = true;
			continue;
		}
		if (!body || !ts.isIdentifier(body) || body.text !== callback.parameters[0].name.text) {
			issues.push({ file, reason: 'Unsupported createApp chain: add useTranslations manually.' });
			continue;
		}
		let local = 'MigratedTranslationManager';
		while (new RegExp(`\\b${local}\\b`).test(input)) local += '_';
		let spec = path
			.relative(path.dirname(file), manager.file)
			.split(path.sep)
			.join('/')
			.replace(/\.[jt]s$/, '');
		if (!spec.startsWith('.')) spec = './' + spec;
		updates.set(
			file,
			`import { ${manager.name} as ${local} } from ${JSON.stringify(spec)};\n` +
				input.slice(0, body.end) +
				`.useTranslations(${local})` +
				input.slice(body.end)
		);
		connected = true;
	}
	if (!connected) {
		issues.push({
			file: manager.file,
			reason: 'Translations require app.useTranslations(TranslationManager); no unambiguous connected bootstrap found.'
		});
		return { updates, issues };
	}
	let unsafeLifecycle = false;
	for (const [file, original] of sources) {
		if (!/\.[jt]s$/.test(file)) continue;
		const input = updates.get(file) ?? original;
		const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
		const options: ts.CompilerOptions = { noLib: true, noResolve: true };
		const host = ts.createCompilerHost(options);
		host.getSourceFile = (name) => (name === file ? source : undefined);
		host.fileExists = (name) => name === file;
		host.readFile = (name) => (name === file ? input : undefined);
		const checker = ts.createProgram([file], options, host).getTypeChecker();
		const accessors = new Set<string>();
		for (const stmt of source.statements)
			if (
				ts.isImportDeclaration(stmt) &&
				ts.isStringLiteral(stmt.moduleSpecifier) &&
				resolve(file, stmt.moduleSpecifier.text) === manager.file
			) {
				const bindings = stmt.importClause?.namedBindings;
				if (bindings && ts.isNamedImports(bindings))
					for (const e of bindings.elements) if ((e.propertyName ?? e.name).text === manager.name) accessors.add(e.name.text);
			}
		const edits: Edit[] = [];
		let unsafe = false;
		const scan = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isObjectBindingPattern(node.name) &&
				node.initializer &&
				ts.isCallExpression(node.initializer) &&
				ts.isIdentifier(node.initializer.expression) &&
				accessors.has(node.initializer.expression.text)
			) {
				const removed = node.name.elements.filter(
					(b) => ts.isIdentifier(b.name) && internal.has((b.propertyName ?? b.name).getText(source))
				);
				for (const b of removed) {
					const binding = checker.getSymbolAtLocation(b.name);
					const refs: ts.Identifier[] = [];
					const find = (n: ts.Node): void => {
						if (n === node.name) return;
						if (binding && ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === binding) refs.push(n);
						ts.forEachChild(n, find);
					};
					find(source);
					for (const ref of refs) {
						const call = ref.parent;
						if (!ts.isCallExpression(call) || call.expression !== ref || call.arguments.length) {
							unsafe = true;
							continue;
						}
						edits.push({ start: call.getStart(source), end: call.end, text: 'Promise.resolve()' });
					}
				}
				if (removed.length) {
					const kept = node.name.elements.filter((b) => !removed.includes(b));
					edits.push({
						start: node.name.getStart(source),
						end: node.name.end,
						text: `{ ${kept.map((b) => b.getText(source)).join(', ')} }`
					});
				}
			}
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				node.moduleSpecifier.text === '@azure-net/edges-translations'
			)
				edits.push({ start: node.moduleSpecifier.getStart(source), end: node.moduleSpecifier.end, text: "'@azure-net/kit/i18n'" });
			ts.forEachChild(node, scan);
		};
		scan(source);
		if (unsafe) {
			unsafeLifecycle = true;
			issues.push({ file, reason: 'Custom translation lifecycle arguments/references: migrate these calls manually to useTranslations.' });
			continue;
		}
		if (edits.length) updates.set(file, patch(input, edits));
	}
	// Do not connect automatic loading while an old custom locale resolver is still active.
	if (unsafeLifecycle) return { updates: new Map<string, string>(), issues };
	const facade = migrateManagerFacade(new Map([...sources, ...updates]), manager, resolve);
	if (facade.issues.length) return { updates: new Map<string, string>(), issues: [...issues, ...facade.issues] };
	return { updates: new Map([...updates, ...facade.updates]), issues };
}

function migrateManagerFacade(
	sources: Map<string, string>,
	manager: { file: string; name: string },
	resolve: (from: string, specifier: string) => string | undefined
) {
	const updates = new Map<string, string>();
	const issues: { file: string; reason: string }[] = [];
	for (const [file, input] of sources) {
		if (!/\.[jt]s$/.test(file)) {
			if (input.includes(manager.name))
				issues.push({ file, reason: 'Translation manager in a non-script source requires manual facade migration.' });
			continue;
		}
		const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
		const edits: Edit[] = [];
		const names = new Set<string>(file === manager.file ? [manager.name] : []);
		for (const statement of source.statements) {
			if (
				ts.isExportDeclaration(statement) &&
				statement.moduleSpecifier &&
				ts.isStringLiteral(statement.moduleSpecifier) &&
				resolve(file, statement.moduleSpecifier.text) === manager.file
			)
				issues.push({ file, reason: 'Translation manager re-export requires manual facade migration.' });
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const bindings = statement.importClause?.namedBindings;
			if (resolve(file, statement.moduleSpecifier.text) === manager.file) {
				if (bindings && ts.isNamedImports(bindings)) {
					for (const binding of bindings.elements)
						if ((binding.propertyName ?? binding.name).text === manager.name) names.add(binding.name.text);
				} else issues.push({ file, reason: 'Namespace/default translation manager import requires manual facade migration.' });
			}
			if (file === manager.file && translationModules.has(statement.moduleSpecifier.text) && bindings && ts.isNamedImports(bindings)) {
				for (const binding of bindings.elements) {
					if ((binding.propertyName ?? binding.name).text !== 'createTranslations') continue;
					edits.push({ start: binding.getStart(source), end: binding.end, text: `TranslationManager as ${binding.name.text}` });
				}
			}
		}
		const options: ts.CompilerOptions = { noLib: true, noResolve: true };
		const host = ts.createCompilerHost(options);
		host.getSourceFile = (name) => (name === file ? source : undefined);
		host.fileExists = (name) => name === file;
		host.readFile = (name) => (name === file ? input : undefined);
		const checker = ts.createProgram([file], options, host).getTypeChecker();
		const symbols = new Set<ts.Symbol>();
		const declarations = (node: ts.Node): void => {
			if (
				(ts.isImportSpecifier(node) || ts.isVariableDeclaration(node)) &&
				ts.isIdentifier(node.name) &&
				names.has(node.name.text) &&
				(ts.isImportSpecifier(node) || (file === manager.file && node.parent.parent.parent === source))
			) {
				const symbol = checker.getSymbolAtLocation(node.name);
				if (symbol) symbols.add(symbol);
			}
			ts.forEachChild(node, declarations);
		};
		declarations(source);
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node)) return;
			if (
				file === manager.file &&
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.name.text === manager.name &&
				node.initializer &&
				ts.isCallExpression(node.initializer)
			)
				edits.push({ start: node.initializer.getStart(source), end: node.initializer.getStart(source), text: 'new ' });
			if (ts.isIdentifier(node) && symbols.has(checker.getSymbolAtLocation(node)!)) {
				const parent = node.parent;
				if (ts.isCallExpression(parent) && parent.expression === node && !parent.arguments.length)
					edits.push({ start: parent.getStart(source), end: parent.end, text: node.text });
				else if (
					!(ts.isVariableDeclaration(parent) && parent.name === node) &&
					!(
						ts.isCallExpression(parent) &&
						ts.isPropertyAccessExpression(parent.expression) &&
						parent.expression.name.text === 'useTranslations'
					)
				)
					issues.push({ file, reason: 'Translation manager escapes a direct accessor call; manual facade migration required.' });
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		if (edits.length) updates.set(file, patch(input, edits));
	}
	return { updates, issues };
}
