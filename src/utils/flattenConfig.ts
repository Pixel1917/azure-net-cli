import ts from 'typescript';

/** Flatten literal-only spreads without evaluating user configuration or duplicating effects. */
export function flattenConfigLiterals(content: string): string {
	const source = ts.createSourceFile('azure-net.config.ts', content, ts.ScriptTarget.Latest, true);
	const exported = source.statements.find(ts.isExportAssignment);
	if (!exported) return content;
	const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
	const root = unwrap(exported.expression);
	if (!ts.isObjectLiteralExpression(root)) return content;
	let changed = false;
	const flatten = (object: ts.ObjectLiteralExpression): ts.ObjectLiteralElementLike[] =>
		object.properties.flatMap((property) => {
			if (ts.isSpreadAssignment(property)) {
				const value = unwrap(property.expression);
				if (
					ts.isObjectLiteralExpression(value) &&
					value.properties.every(
						(p) =>
							!ts.isGetAccessorDeclaration(p) &&
							!ts.isSetAccessorDeclaration(p) &&
							!(p.name && p.name.getText(source).replace(/['"]/g, '') === '__proto__')
					)
				) {
					changed = true;
					return flatten(value);
				}
			}
			return [property];
		});
	const properties = flatten(root);
	if (!changed) return content;
	const names = properties
		.filter((p) => p.name && !ts.isComputedPropertyName(p.name))
		.map((p) => p.name!.getText(source).replace(/['"]/g, ''));
	// Duplicate literal keys can produce invalid TypeScript; retain the original spread semantics.
	if (new Set(names).size !== names.length) return content;
	const updated = ts.factory.updateObjectLiteralExpression(root, properties);
	const printed = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(ts.EmitHint.Expression, updated, source);
	return content.slice(0, root.getStart(source)) + printed + content.slice(root.end);
}
