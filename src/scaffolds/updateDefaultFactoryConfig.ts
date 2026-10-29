import ts from 'typescript';
import { flattenConfigLiterals } from '../utils/flattenConfig.js';

export function updateDefaultFactoryConfig(
	content: string,
	key: 'defaultSchemaFactory' | 'runChecksBeforePush' | 'packageManager',
	name: string | boolean
): string {
	content = flattenConfigLiterals(content);
	if (!content.trim()) return `export default {\n\t${key}: ${JSON.stringify(name)}\n};\n`;
	const source = ts.createSourceFile('azure-net.config.ts', content, ts.ScriptTarget.Latest, true);
	const exported = source.statements.find(ts.isExportAssignment);
	if (!exported || exported.isExportEquals) throw new Error('Cannot update factory default: expected a default-exported config.');
	const expression = exported.expression;
	if (ts.isObjectLiteralExpression(expression)) {
		const lastSpread = expression.properties.reduce((last, item, index) => (ts.isSpreadAssignment(item) ? index : last), -1);
		const property = [...expression.properties.slice(lastSpread + 1)]
			.reverse()
			.find(
				(item) => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === key
			);
		if (property && ts.isPropertyAssignment(property)) {
			if (ts.isStringLiteral(property.initializer) && property.initializer.text === name) return content;
			return content.slice(0, property.initializer.getStart(source)) + JSON.stringify(name) + content.slice(property.initializer.end);
		}
		const last = expression.properties.at(-1);
		let result = content.slice(0, expression.end - 1) + `\n\t${key}: ${JSON.stringify(name)}\n` + content.slice(expression.end - 1);
		if (last && !expression.properties.hasTrailingComma) result = result.slice(0, last.end) + ',' + result.slice(last.end);
		return result;
	}
	// Preserve custom config expressions without executing or reconstructing their contents.
	const replacement = `{ ...(${expression.getText(source)}), ${key}: ${JSON.stringify(name)} }`;
	return content.slice(0, expression.getStart(source)) + replacement + content.slice(expression.end);
}
