import ts from 'typescript';

export interface FactoryDefinition {
	name: string;
	exportName: string;
	keys: Set<string>;
	helpers: Set<string>;
}
const kitModules = new Set(['@azure-net/kit/delivery', '@azure-net/edges']);
const helperNames = new Set(['createAsyncAction', 'createAsyncResource']);
const unwrap = (node: ts.Expression): ts.Expression =>
	ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
		? unwrap(node.expression)
		: node;

/** Only evaluate syntax. Never import or execute the application's factory/configuration. */
export function inspectFactories(input: string, file: string): FactoryDefinition[] {
	const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
	const creators = new Set<string>();
	const helperFactories = new Set<string>();
	const helpers = new Map<string, string>();
	const occupied = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) occupied.add(node.text);
		ts.forEachChild(node, visit);
	};
	visit(source);
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			!kitModules.has(statement.moduleSpecifier.text) ||
			statement.importClause?.isTypeOnly
		)
			continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const binding of bindings.elements) {
			if (binding.isTypeOnly) continue;
			const name = (binding.propertyName ?? binding.name).text;
			if (name === 'createPresenterFactory') creators.add(binding.name.text);
			if (name === 'createAsyncHelpers') helperFactories.add(binding.name.text);
			if (helperNames.has(name)) helpers.set(binding.name.text, name);
		}
	}
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			const init = declaration.initializer && unwrap(declaration.initializer);
			if (!init || !ts.isObjectBindingPattern(declaration.name)) continue;
			const available = new Set<string>();
			if (
				ts.isCallExpression(init) &&
				ts.isIdentifier(init.expression) &&
				helperFactories.has(init.expression.text) &&
				!init.arguments.length
			) {
				for (const helper of helperNames) available.add(helper);
			} else if (ts.isObjectLiteralExpression(init)) {
				for (const property of init.properties) {
					if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
					const value = unwrap(property.initializer);
					if (ts.isIdentifier(value) && helpers.get(value.text) === property.name.text) available.add(property.name.text);
				}
			}
			for (const binding of declaration.name.elements) {
				const key = binding.propertyName ?? binding.name;
				if (
					ts.isIdentifier(key) &&
					ts.isIdentifier(binding.name) &&
					available.has(key.text) &&
					!binding.initializer &&
					!binding.dotDotDotToken
				)
					helpers.set(binding.name.text, key.text);
			}
		}
	}
	const found: FactoryDefinition[] = [];
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
		const declaration = statement.declarationList.declarations[0]!;
		const init = declaration.initializer;
		if (
			!ts.isIdentifier(declaration.name) ||
			!init ||
			!ts.isCallExpression(init) ||
			!ts.isIdentifier(init.expression) ||
			!creators.has(init.expression.text) ||
			init.arguments.length !== 1
		)
			continue;
		const config = init.arguments[0]!;
		if (!ts.isObjectLiteralExpression(config)) continue;
		const keys = new Set<string>();
		const directHelpers = new Set<string>();
		let safe = true;
		for (const property of config.properties) {
			if (ts.isSpreadAssignment(property)) {
				const call = property.expression;
				if (
					!ts.isCallExpression(call) ||
					!ts.isIdentifier(call.expression) ||
					!helperFactories.has(call.expression.text) ||
					call.arguments.length
				) {
					safe = false;
					break;
				}
				for (const helper of helperNames) {
					keys.add(helper);
					directHelpers.add(helper);
				}
				continue;
			}
			if (
				(!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
				!property.name ||
				(!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
			) {
				safe = false;
				break;
			}
			const key = property.name.text;
			if (keys.has(key)) {
				safe = false;
				break;
			}
			keys.add(key);
			const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
			if (ts.isIdentifier(value) && helpers.get(value.text) === key) directHelpers.add(key);
		}
		if (!safe) continue;
		let exportName = declaration.name.text + 'Dependencies';
		while (occupied.has(exportName)) exportName += '_';
		occupied.add(exportName);
		found.push({ name: declaration.name.text, exportName, keys, helpers: directHelpers });
	}
	return found;
}

export function replaceFactory(input: string, file: string, definition: FactoryDefinition, keepLegacy: boolean): string {
	const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
	let creator: string | undefined;
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
		const declaration = statement.declarationList.declarations[0]!;
		if (
			!ts.isIdentifier(declaration.name) ||
			declaration.name.text !== definition.name ||
			!declaration.initializer ||
			!ts.isCallExpression(declaration.initializer)
		)
			continue;
		const call = declaration.initializer;
		creator = call.expression.getText(source);
		const config = call.arguments[0]!.getText(source);
		const replacement =
			`export const ${definition.exportName} = ${config};\n` +
			(keepLegacy ? `export const ${definition.name} = ${creator}(${definition.exportName});` : '');
		input = input.slice(0, statement.getStart(source)) + replacement + input.slice(statement.end);
		break;
	}
	if (!creator || keepLegacy) return input;
	const parsed = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
	let used = false;
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) return;
		if (ts.isIdentifier(node) && node.text === creator) used = true;
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	if (used) return input;
	for (const statement of [...parsed.statements].reverse()) {
		if (
			!ts.isImportDeclaration(statement) ||
			!statement.importClause?.namedBindings ||
			!ts.isNamedImports(statement.importClause.namedBindings)
		)
			continue;
		const bindings = statement.importClause.namedBindings;
		const kept = bindings.elements.filter((binding) => binding.name.text !== creator);
		if (kept.length === bindings.elements.length) continue;
		if (!kept.length && !statement.importClause.name) input = input.slice(0, statement.getStart(parsed)) + input.slice(statement.end);
		else
			input =
				input.slice(0, bindings.getStart(parsed)) +
				`{ ${kept.map((binding) => binding.getText(parsed)).join(', ')} }` +
				input.slice(bindings.end);
	}
	return input;
}
