import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { VITE_CONFIGS, formatConfig, enableHydratable } from '../utils/viteConfig.js';

export function configureAzureNetPlugin(content: string): string {
	const source = ts.createSourceFile('vite.config.ts', content, ts.ScriptTarget.Latest, true);
	const edits: Array<{ start: number; end: number; text: string }> = [];
	let pluginName = 'AzureNetPlugin';
	let imported = false;
	const legacyNames = new Set<string>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		if (statement.moduleSpecifier.text === '@azure-net/kit/plugin') {
			for (const item of bindings.elements)
				if ((item.propertyName?.text ?? item.name.text) === 'AzureNetPlugin') {
					pluginName = item.name.text;
					imported = true;
				}
		}
		if (statement.moduleSpecifier.text === '@azure-net/kit/edges/plugin') {
			for (const item of bindings.elements)
				if ((item.propertyName?.text ?? item.name.text) === 'edgesPlugin') legacyNames.add(item.name.text);
			if (bindings.elements.some((item) => (item.propertyName?.text ?? item.name.text) !== 'edgesPlugin'))
				throw new Error('Remove unsupported legacy edges/plugin imports from Vite config first.');
			edits.push({ start: statement.getStart(source), end: statement.end, text: '' });
		}
	}
	let plugins: ts.ArrayLiteralExpression | undefined;
	const visit = (node: ts.Node): void => {
		if (
			ts.isPropertyAssignment(node) &&
			(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
			node.name.text === 'plugins' &&
			ts.isArrayLiteralExpression(node.initializer)
		)
			plugins ??= node.initializer;
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (!plugins) throw new Error('Cannot safely configure AzureNetPlugin: use a literal plugins array in vite.config.');
	const existing = plugins.elements.some(
		(element) => ts.isCallExpression(element) && ts.isIdentifier(element.expression) && element.expression.text === pluginName
	);
	let replacedLegacy = false;
	for (const element of plugins.elements) {
		if (!ts.isCallExpression(element) || !ts.isIdentifier(element.expression) || !legacyNames.has(element.expression.text)) continue;
		if (existing || replacedLegacy)
			throw new Error('Both legacy and AzureNet plugins are configured. Remove the legacy plugin call first.');
		edits.push({ start: element.getStart(source), end: element.end, text: `${pluginName}()` });
		replacedLegacy = true;
	}
	if (!existing && !replacedLegacy) {
		const last = plugins.elements.at(-1);
		edits.push({ start: plugins.end - 1, end: plugins.end - 1, text: `\n${pluginName}()\n` });
		if (last && !plugins.elements.hasTrailingComma) edits.push({ start: last.end, end: last.end, text: ',' });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
	if (!imported) content = `import { AzureNetPlugin } from '@azure-net/kit/plugin';\n${content}`;
	return enableHydratable(content);
}

export default async function initEdges(): Promise<void> {
	for (const name of VITE_CONFIGS) {
		const file = path.resolve(name);
		let content: string;
		try {
			content = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		await fs.writeFile(file, await formatConfig(configureAzureNetPlugin(content), file));
		console.log(`AzureNetPlugin configured in ${name}`);
		return;
	}
	throw new Error('vite.config.(ts|js|mjs) was not found. Initialize a SvelteKit project first.');
}
