import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import ts from 'typescript';
import { selectContext } from './repositoryModuleShared.js';

type InterfaceDeclaration = {
	name: string;
	openBraceIndex: number;
	closeBraceIndex: number;
	body: string;
};

const isValidIdentifier = (value: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);

const toPropertyName = (key: string): string => (isValidIdentifier(key) ? key : JSON.stringify(key));

const getIndent = (level: number): string => '\t'.repeat(level);

export const parseObjectInput = (rawValue: unknown): Record<string, unknown> => {
	let input = String(rawValue ?? '')
		.trim()
		.replace(/;$/, '');
	if (!input) throw new Error('Input is empty');
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, input);
	const stack: ts.SyntaxKind[] = [];
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token === ts.SyntaxKind.OpenBraceToken || token === ts.SyntaxKind.OpenBracketToken) stack.push(token);
		if (token === ts.SyntaxKind.CloseBraceToken || token === ts.SyntaxKind.CloseBracketToken) {
			const expected = token === ts.SyntaxKind.CloseBraceToken ? ts.SyntaxKind.OpenBraceToken : ts.SyntaxKind.OpenBracketToken;
			if (stack.pop() !== expected) throw new Error('Unbalanced object');
		}
	}
	input += stack
		.reverse()
		.map((token) => (token === ts.SyntaxKind.OpenBraceToken ? '}' : ']'))
		.join('');
	const source = ts.createSourceFile('Input.ts', 'const input = (' + input + ');', ts.ScriptTarget.Latest, true);
	const diagnostics = ts.transpileModule(source.text, { reportDiagnostics: true }).diagnostics ?? [];
	if (diagnostics.length || source.statements.length !== 1) throw new Error('Invalid object literal');
	const statement = source.statements[0];
	if (!statement || !ts.isVariableStatement(statement)) throw new Error('Invalid object literal');
	const parseValue = (node: ts.Expression | undefined): unknown => {
		if (!node) throw new Error('Missing value');
		if (ts.isParenthesizedExpression(node)) return parseValue(node.expression);
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
		if (ts.isNumericLiteral(node)) return Number(node.text);
		if (
			ts.isPrefixUnaryExpression(node) &&
			ts.isNumericLiteral(node.operand) &&
			[ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)
		)
			return Number(node.operand.text) * (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
		if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
		if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
		if (node.kind === ts.SyntaxKind.NullKeyword) return null;
		if (ts.isIdentifier(node) && node.text === 'undefined') return undefined;
		if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => parseValue(element));
		if (ts.isObjectLiteralExpression(node)) {
			const value = Object.create(null) as Record<string, unknown>;
			for (const property of node.properties) {
				if (
					!ts.isPropertyAssignment(property) ||
					(!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name) && !ts.isNumericLiteral(property.name))
				)
					throw new Error('Only data properties are supported');
				value[property.name.text] = parseValue(property.initializer);
			}
			return value;
		}
		throw new Error('Only JSON/JS data literals are supported; executable code is not allowed');
	};
	const result = parseValue(statement.declarationList.declarations[0]?.initializer);
	if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Input root must be an object');
	return result as Record<string, unknown>;
};

const stringifyType = (value: unknown, level = 1): string => {
	if (value === null) return 'null';

	const valueType = typeof value;
	if (valueType === 'string') return 'string';
	if (valueType === 'number') return Number.isFinite(value as number) ? 'number' : 'unknown';
	if (valueType === 'boolean') return 'boolean';
	if (valueType === 'bigint') return 'bigint';
	if (valueType === 'undefined') return 'undefined';

	if (Array.isArray(value)) {
		if (!value.length) return 'unknown[]';

		const itemTypes = Array.from(new Set(value.map((item) => stringifyType(item, level + 1))));
		if (itemTypes.length === 1) {
			const single = itemTypes[0] ?? 'unknown';
			if (single.includes('\n')) return `Array<${single}>`;
			return `${single}[]`;
		}

		const union = itemTypes.join(' | ');
		if (union.includes('\n')) return `Array<${union}>`;
		return `(${union})[]`;
	}

	if (valueType === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		if (!entries.length) return 'Record<string, unknown>';

		const lines = entries.map(([entryKey, entryValue]) => {
			const propertyType = stringifyType(entryValue, level + 1);
			return `${getIndent(level + 1)}${toPropertyName(entryKey)}: ${propertyType};`;
		});

		return `{\n${lines.join('\n')}\n${getIndent(level)}}`;
	}

	return 'unknown';
};

const findInterfaceDeclaration = (content: string): InterfaceDeclaration | null => {
	const source = ts.createSourceFile('Model.ts', content, ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find(ts.isInterfaceDeclaration);
	if (!declaration) return null;
	const openBraceIndex = declaration.members.pos - 1;
	const closeBraceIndex = declaration.end - 1;
	return { name: declaration.name.text, openBraceIndex, closeBraceIndex, body: content.slice(openBraceIndex + 1, closeBraceIndex) };
};

const extractExistingRootKeys = (body: string): Set<string> => {
	const source = ts.createSourceFile('Model.ts', 'interface IModel {' + body + '}', ts.ScriptTarget.Latest, true);
	const declaration = source.statements.find(ts.isInterfaceDeclaration);
	return new Set(
		declaration?.members.flatMap((member) =>
			member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name))
				? [member.name.text]
				: []
		) ?? []
	);
};

const listModelFiles = async (contextName: string): Promise<Array<{ name: string; path: string }>> => {
	const modelRoot = path.join(process.cwd(), 'src', 'app', 'Contexts', contextName, 'Domain', 'Entities');
	try {
		const files = await fs.readdir(modelRoot);
		return files
			.filter((fileName) => fileName.endsWith('.ts') && fileName !== 'index.ts')
			.map((fileName) => ({
				name: fileName.replace(/\.ts$/, ''),
				path: path.join(modelRoot, fileName)
			}));
	} catch {
		return [];
	}
};

export default async function generateTypesJson(): Promise<void> {
	const contextName = await selectContext('Select context for model update:');
	if (!contextName) {
		process.exitCode = 1;
		return;
	}

	const models = await listModelFiles(contextName);
	if (!models.length) {
		console.error(`❌ No model files found in context "${contextName}".`);
		process.exitCode = 1;
		return;
	}

	const { modelPath } = await prompts({
		type: 'select',
		name: 'modelPath',
		message: 'Select model:',
		choices: models.map((item) => ({ title: item.name, value: item.path })),
		initial: 0
	});

	if (!modelPath) {
		process.exitCode = 1;
		return;
	}

	const { rawJson } = await prompts({
		type: 'text',
		name: 'rawJson',
		message: 'Paste JSON or JS object (single line):',
		validate: (value: string) => {
			try {
				parseObjectInput(value);
				return true;
			} catch {
				return 'Invalid JSON/JS object';
			}
		}
	});

	if (!rawJson) {
		process.exitCode = 1;
		return;
	}

	const parsedJson = parseObjectInput(rawJson);
	const content = await fs.readFile(String(modelPath), 'utf-8');
	const interfaceDeclaration = findInterfaceDeclaration(content);
	if (!interfaceDeclaration) {
		console.error(`❌ Unable to parse interface in ${modelPath}`);
		process.exitCode = 1;
		return;
	}

	const existingKeys = extractExistingRootKeys(interfaceDeclaration.body);
	const generatedLines = Object.entries(parsedJson)
		.filter(([key]) => !existingKeys.has(key))
		.map(([key, value]) => `${getIndent(1)}${toPropertyName(key)}: ${stringifyType(value, 1)};`);

	if (!generatedLines.length) {
		console.log('ℹ️ No new keys to add. Model already contains all JSON keys.');
		return;
	}

	const trimmedBody = interfaceDeclaration.body.trimEnd();
	const bodyPrefix = trimmedBody.length ? `${trimmedBody}\n` : '';
	const newBody = `${bodyPrefix}${generatedLines.join('\n')}\n`;

	const updatedContent = `${content.slice(0, interfaceDeclaration.openBraceIndex + 1)}${newBody}${content.slice(interfaceDeclaration.closeBraceIndex)}`;
	await fs.writeFile(String(modelPath), updatedContent, 'utf-8');

	console.log(`✅ Model updated: ${modelPath}`);
}
