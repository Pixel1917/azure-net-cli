import ts from 'typescript';
export function mergeAliasesInSvelteConfig(content: string, aliases: Record<string, string>): string {
	const source = ts.createSourceFile('svelte.config.js', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	function resolve(expression: ts.Expression, seen = new Set<string>()): ts.ObjectLiteralExpression {
		if (ts.isObjectLiteralExpression(expression)) return expression;
		if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
			return resolve(expression.expression, seen);
		if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
			seen.add(expression.text);
			for (const statement of source.statements)
				if (ts.isVariableStatement(statement)) {
					for (const declaration of statement.declarationList.declarations)
						if (ts.isIdentifier(declaration.name) && declaration.name.text === expression.text && declaration.initializer)
							return resolve(declaration.initializer, seen);
				}
		}
		throw new Error('Cannot safely merge Svelte aliases: use an object literal or a local object variable for the config and kit.');
	}
	const exported = source.statements.find(ts.isExportAssignment);
	if (!exported) throw new Error('Cannot safely merge Svelte aliases: no default export found.');
	const root = resolve(exported.expression);
	const property = (object: ts.ObjectLiteralExpression, name: string) =>
		[...object.properties]
			.reverse()
			.find((entry) => entry.name && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name);
	const value = (entry: ts.ObjectLiteralElementLike): ts.Expression => {
		if (ts.isPropertyAssignment(entry)) return entry.initializer;
		if (ts.isShorthandPropertyAssignment(entry)) return entry.name;
		throw new Error('Cannot safely merge Svelte aliases: unsupported property declaration.');
	};
	const insert = (object: ts.ObjectLiteralExpression, text: string): string => {
		const last = object.properties.at(-1);
		const comma = last && !object.properties.hasTrailingComma ? ',' : '';
		// Insert the separator before any trailing line comment.
		let next = content.slice(0, object.end - 1) + `\n${text}\n` + content.slice(object.end - 1);
		if (last && comma) next = next.slice(0, last.end) + comma + next.slice(last.end);
		return next;
	};
	const entries = Object.entries(aliases)
		.map(([key, target]) => `${JSON.stringify(key)}: ${JSON.stringify(target)}`)
		.join(',\n');
	const kit = property(root, 'kit');
	if (!kit) return insert(root, `kit: { alias: { ${entries} } }`);
	const kitObject = resolve(value(kit));
	const alias = property(kitObject, 'alias');
	if (!alias) return insert(kitObject, `alias: { ${entries} }`);
	const expression = value(alias);
	if (ts.isObjectLiteralExpression(expression)) {
		const missing = Object.entries(aliases).filter(([key, target]) => {
			const entry = property(expression, key);
			if (!entry || !ts.isPropertyAssignment(entry) || !ts.isStringLiteral(entry.initializer) || entry.initializer.text !== target)
				return true;
			// Later spreads or computed keys can override an otherwise correct entry.
			return expression.properties
				.slice(expression.properties.indexOf(entry) + 1)
				.some((later) => ts.isSpreadAssignment(later) || (later.name && ts.isComputedPropertyName(later.name)));
		});
		if (!missing.length) return content;
		if (missing.every(([key]) => !property(expression, key))) {
			return insert(expression, missing.map(([key, target]) => `${JSON.stringify(key)}: ${JSON.stringify(target)}`).join(',\n'));
		}
	}
	// Preserve every user expression, spread and comment; fixed architecture aliases win.
	const replacement = `{ ...(${expression.getText(source)}), ${entries} }`;
	if (ts.isShorthandPropertyAssignment(alias))
		return content.slice(0, alias.getStart(source)) + `alias: ${replacement}` + content.slice(alias.end);
	return content.slice(0, expression.getStart(source)) + replacement + content.slice(expression.end);
}
