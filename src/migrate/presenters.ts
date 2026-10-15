import ts from 'typescript';
import { parseSource } from '../checks/architecture.js';

const printer = ts.createPrinter();
const helperNames = new Set(['createAsyncAction', 'createAsyncResource']);
type Edit = { start: number; end: number; text: string };
const apply = (input: string, edits: Edit[]) => {
	for (const edit of edits.sort((a, b) => b.start - a.start)) input = input.slice(0, edit.start) + edit.text + input.slice(edit.end);
	return input;
};

export function migrateAsyncHelpers(input: string, file: string): string {
	const source = parseSource(input, file);
	const edits: Edit[] = [];
	const factories = new Set<string>();
	const occupied = new Set<string>();
	const collect = (node: ts.Node) => {
		if (ts.isIdentifier(node)) occupied.add(node.text);
		ts.forEachChild(node, collect);
	};
	collect(source);
	const unique = (base: string) => {
		let name = base;
		while (occupied.has(name)) name += '_';
		occupied.add(name);
		return name;
	};
	const action = unique('kitCreateAsyncAction');
	const resource = unique('kitCreateAsyncResource');
	let helpersImported = false;
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== '@azure-net/kit/delivery'
		)
			continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		const kept = bindings.elements.filter((entry) => {
			if ((entry.propertyName ?? entry.name).text !== 'createAsyncHelpers') return true;
			factories.add(entry.name.text);
			return false;
		});
		if (kept.length === bindings.elements.length) continue;
		const extra = helpersImported ? [] : [`createAsyncAction as ${action}`, `createAsyncResource as ${resource}`];
		helpersImported = true;
		edits.push({
			start: bindings.getStart(source),
			end: bindings.end,
			text: `{ ${[...kept.map((e) => e.getText(source)), ...extra].join(', ')} }`
		});
	}
	if (!factories.size) return input;
	const validate = (node: ts.Node) => {
		if (ts.isImportDeclaration(node)) return;
		if (ts.isIdentifier(node) && factories.has(node.text)) {
			if (!ts.isCallExpression(node.parent) || node.parent.expression !== node || node.parent.arguments.length) {
				throw new Error(`${node.text} is not a direct zero-argument call`);
			}
		}
		ts.forEachChild(node, validate);
	};
	validate(source);
	const specialize = (name: string, errorType?: string) =>
		errorType
			? `${name} as <Res = never, Req = never>(...args: Parameters<typeof ${name}<Res, Req, ${errorType}>>) => ReturnType<typeof ${name}<Res, Req, ${errorType}>>`
			: name;
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && factories.has(node.expression.text) && !node.arguments.length) {
			const errorType = node.typeArguments?.[0]?.getText(source);
			edits.push({
				start: node.getStart(source),
				end: node.end,
				text: `({ createAsyncAction: ${specialize(action, errorType)}, createAsyncResource: ${specialize(resource, errorType)} })`
			});
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return apply(input, edits);
}

/** Upgrade only recognized factories; arbitrary injected dependencies require a human decision. */
export function migratePresenterSource(input: string, file: string, factories: Set<string>) {
	const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
	const edits: Edit[] = [];
	const converted = new Map<string, string>();
	const issues: string[] = [];
	const imports = new Set<string>();
	const removedFactories = new Set<string>();
	const existingImports = new Set<string>();
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== '@azure-net/kit/delivery' ||
			statement.importClause?.isTypeOnly
		)
			continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings))
			for (const entry of bindings.elements) {
				if (!entry.isTypeOnly)
					existingImports.add(entry.propertyName ? `${entry.propertyName.text} as ${entry.name.text}` : entry.name.text);
			}
	}
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
		const declaration = statement.declarationList.declarations[0]!;
		const call = declaration.initializer;
		if (
			!ts.isIdentifier(declaration.name) ||
			!call ||
			!ts.isCallExpression(call) ||
			!ts.isIdentifier(call.expression) ||
			!factories.has(call.expression.text)
		)
			continue;
		const name = declaration.name.text;
		try {
			const callback = call.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
			if (
				!callback ||
				(!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
				!ts.isBlock(callback.body) ||
				callback.typeParameters ||
				callback.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
			)
				throw new Error('Expected a synchronous block factory');
			if (call.arguments.length !== 2 || !ts.isStringLiteral(call.arguments[0]!))
				throw new Error('Custom factory arguments need manual review');
			const requestedImports = new Set<string>();
			if (callback.parameters.length) {
				const param = callback.parameters[0]!;
				if (callback.parameters.length !== 1 || !ts.isObjectBindingPattern(param.name) || param.initializer)
					throw new Error('Unsupported injected dependencies');
				for (const binding of param.name.elements) {
					const original = (binding.propertyName ?? binding.name).getText(source);
					if (!helperNames.has(original) || !ts.isIdentifier(binding.name) || binding.initializer || binding.dotDotDotToken)
						throw new Error(`Injected dependency ${original} requires manual conversion`);
					requestedImports.add(original === binding.name.text ? original : `${original} as ${binding.name.text}`);
				}
			}
			const statements = [...callback.body.statements];
			let usesThis = false;
			const findThis = (node: ts.Node) => {
				if (node.kind === ts.SyntaxKind.ThisKeyword) usesThis = true;
				ts.forEachChild(node, findThis);
			};
			findThis(callback.body);
			if (usesThis) throw new Error('Explicit this binding requires manual conversion');
			const result = statements.at(-1);
			if (!result || !ts.isReturnStatement(result) || !result.expression || !ts.isObjectLiteralExpression(result.expression))
				throw new Error('Expected a final object-literal return');
			const keys = result.expression.properties.map((prop) => {
				if (!prop.name || !ts.isIdentifier(prop.name)) throw new Error('Spread/computed return keys require manual conversion');
				if (prop.name.text === 'constructor') throw new Error('Reserved presenter member');
				return prop.name.text;
			});
			if (new Set(keys).size !== keys.length) throw new Error('Duplicate return keys');
			const parameters: string[] = [];
			const argumentsList: string[] = [];
			const registrations: string[] = [];
			const body = statements.filter((stmt) => {
				if (!ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1) return true;
				const binding = stmt.declarationList.declarations[0]!;
				const value = binding.initializer;
				if (
					!ts.isObjectBindingPattern(binding.name) ||
					!value ||
					!ts.isCallExpression(value) ||
					!ts.isIdentifier(value.expression) ||
					!/Provider$/.test(value.expression.text)
				)
					return true;
				if (value.arguments.length) throw new Error('Provider arguments require manual conversion');
				for (const entry of binding.name.elements) {
					if (!ts.isIdentifier(entry.name) || entry.dotDotDotToken || entry.initializer)
						throw new Error('Unsupported provider destructuring');
					const key = (entry.propertyName ?? entry.name).getText(source).replace(/^['"]|['"]$/g, '');
					parameters.push(`${entry.name.text}: ReturnType<typeof ${value.expression.text}>[${JSON.stringify(key)}]`);
					argumentsList.push(entry.name.text);
				}
				registrations.push(stmt.getText(source));
				return false;
			});
			// Keep lexical state and callbacks intact rather than guessing this-binding rewrites.
			const setup = `create${name}State`;
			if (new RegExp(`\\b(?:use${name}|${setup})\\b`).test(input)) throw new Error('Generated declaration name already exists');
			const javascript = file.endsWith('.js');
			const parameterList = (javascript ? argumentsList : parameters).join(', ');
			const members = result.expression.properties.map((property, index) => {
				const key = keys[index]!;
				return (
					`get ${key}() { return this.#state.${key}; }` +
					(ts.isGetAccessorDeclaration(property) || callback.type
						? ''
						: `\nset ${key}(value${javascript ? '' : `: ReturnType<typeof ${setup}>[${JSON.stringify(key)}]`}) { this.#state.${key} = value; }`)
				);
			});
			const text = `function ${setup}(${parameterList})${callback.type ? ': ' + callback.type.getText(source) : ''} {\n${body.map((stmt) => stmt.getText(source)).join('\n')}\n}\n\nexport class ${name} {\n#state${javascript ? '' : `: ReturnType<typeof ${setup}>`};\nconstructor(${parameterList}) { this.#state = ${setup}(${argumentsList.join(', ')}); }\n${members.join('\n')}\n}\n\nexport const use${name} = RegisterProvider(() => {\n${registrations.join('\n')}\nreturn new ${name}(${argumentsList.join(', ')});\n}, 'scoped');`;
			edits.push({ start: statement.getStart(source), end: statement.end, text });
			converted.set(name, `use${name}`);
			removedFactories.add(call.expression.text);
			imports.add('RegisterProvider');
			for (const helper of requestedImports) imports.add(helper);
		} catch (error) {
			issues.push(`${name}: ${String(error)}. Original presenter retained.`);
		}
	}
	let output = apply(input, edits);
	if (converted.size) {
		const parsed = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true);
		const importEdits: Edit[] = [];
		for (const statement of parsed.statements) {
			if (
				!ts.isImportDeclaration(statement) ||
				!statement.importClause?.namedBindings ||
				!ts.isNamedImports(statement.importClause.namedBindings)
			)
				continue;
			const bindings = statement.importClause.namedBindings;
			const kept = bindings.elements.filter((entry) => {
				if (!removedFactories.has(entry.name.text)) return true;
				let used = false;
				const visit = (node: ts.Node) => {
					if (ts.isImportDeclaration(node)) return;
					if (ts.isIdentifier(node) && node.text === entry.name.text) used = true;
					ts.forEachChild(node, visit);
				};
				visit(parsed);
				return used;
			});
			if (kept.length === bindings.elements.length) continue;
			const updated =
				kept.length || statement.importClause.name
					? ts.factory.updateImportDeclaration(
							statement,
							statement.modifiers,
							ts.factory.updateImportClause(
								statement.importClause,
								statement.importClause.isTypeOnly,
								statement.importClause.name,
								kept.length ? ts.factory.updateNamedImports(bindings, kept) : undefined
							),
							statement.moduleSpecifier,
							statement.attributes
						)
					: undefined;
			importEdits.push({
				start: statement.getStart(parsed),
				end: statement.end,
				text: updated ? printer.printNode(ts.EmitHint.Unspecified, updated, parsed) : ''
			});
		}
		const neededImports = [...imports].filter((name) => !existingImports.has(name));
		output =
			(neededImports.length ? `import { ${neededImports.join(', ')} } from '@azure-net/kit/delivery';\n` : '') + apply(output, importEdits);
		const updated = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true);
		const references: Edit[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && converted.has(node.expression.text)) {
				references.push({ start: node.expression.getStart(updated), end: node.expression.end, text: converted.get(node.expression.text)! });
			}
			ts.forEachChild(node, visit);
		};
		visit(updated);
		output = apply(output, references);
	}
	return { content: output, converted, issues };
}
