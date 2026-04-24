import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { selectContext } from './repositoryModuleShared.js';

type InterfaceDeclaration = {
	name: string;
	openBraceIndex: number;
	closeBraceIndex: number;
	body: string;
};

const isValidIdentifier = (value: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);

const toPropertyName = (key: string): string => (isValidIdentifier(key) ? key : `'${String(key).replace(/'/g, "\\'")}'`);

const getIndent = (level: number): string => '\t'.repeat(level);

const normalizeObjectInput = (rawValue: unknown): string => {
	let input = String(rawValue ?? '').trim();
	if (input.endsWith(';')) {
		input = input.slice(0, -1).trim();
	}

	const openCurly = (input.match(/\{/g) ?? []).length;
	const closeCurly = (input.match(/\}/g) ?? []).length;
	if (openCurly > closeCurly) {
		input += '}'.repeat(openCurly - closeCurly);
	}

	return input;
};

const parseObjectInput = (rawValue: unknown): Record<string, unknown> => {
	const input = normalizeObjectInput(rawValue);
	if (!input.length) {
		throw new Error('Input is empty');
	}

	try {
		const parsed = JSON.parse(input);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Input root must be an object');
		}
		return parsed as Record<string, unknown>;
	} catch {
		// fallback to JS object literal
	}

	const parsed = new Function(`"use strict"; return (${input});`)();
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Input root must be an object');
	}
	return parsed as Record<string, unknown>;
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
	const declarationMatch = content.match(/export\s+interface\s+([A-Za-z0-9_]+)\s*\{/);
	if (!declarationMatch || declarationMatch.index === undefined) return null;

	const name = declarationMatch[1] ?? 'Interface';
	const openBraceIndex = content.indexOf('{', declarationMatch.index);
	if (openBraceIndex === -1) return null;

	let depth = 0;
	let closeBraceIndex = -1;
	for (let index = openBraceIndex; index < content.length; index += 1) {
		const char = content[index];
		if (char === '{') depth += 1;
		if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				closeBraceIndex = index;
				break;
			}
		}
	}

	if (closeBraceIndex === -1) return null;

	const body = content.slice(openBraceIndex + 1, closeBraceIndex);
	return {
		name,
		openBraceIndex,
		closeBraceIndex,
		body
	};
};

const extractExistingRootKeys = (body: string): Set<string> => {
	const keys = new Set<string>();
	const keyRegex = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm;
	let match: RegExpExecArray | null;
	while ((match = keyRegex.exec(body)) !== null) {
		const key = match[1];
		if (key) keys.add(key);
	}
	return keys;
};

const listDomains = async (contextName: string): Promise<string[]> => {
	const domainRoot = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'domain');
	try {
		const items = await fs.readdir(domainRoot, { withFileTypes: true });
		return items.filter((item) => item.isDirectory()).map((item) => item.name);
	} catch {
		return [];
	}
};

const listModelFiles = async (contextName: string, domainName: string): Promise<Array<{ name: string; path: string }>> => {
	const modelRoot = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'domain', domainName, 'model');
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

	const domains = await listDomains(contextName);
	if (!domains.length) {
		console.error(`❌ No domains found in context "${contextName}".`);
		process.exitCode = 1;
		return;
	}

	const { domainName } = await prompts({
		type: 'select',
		name: 'domainName',
		message: 'Select domain:',
		choices: domains.map((item) => ({ title: item, value: item })),
		initial: 0
	});

	if (!domainName) {
		process.exitCode = 1;
		return;
	}

	const models = await listModelFiles(contextName, String(domainName));
	if (!models.length) {
		console.error(`❌ No model files found in domain "${domainName}".`);
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
