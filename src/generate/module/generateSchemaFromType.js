import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { getConfigState, resolveContextAlias, selectContext } from './repositoryModuleShared.js';

const listDirectories = async (targetPath) => {
	try {
		const items = await fs.readdir(targetPath, { withFileTypes: true });
		return items.filter((item) => item.isDirectory()).map((item) => item.name);
	} catch {
		return [];
	}
};

const listSchemaFiles = async (targetPath) => {
	try {
		const files = await fs.readdir(targetPath);
		return files.filter((item) => item.endsWith('.ts') && item !== 'index.ts');
	} catch {
		return [];
	}
};

const resolveAliasMap = async () => {
	const { contexts, coreAlias } = await getConfigState();
	const map = new Map();
	map.set(coreAlias, path.join(process.cwd(), 'src', 'core'));

	for (const context of contexts) {
		const alias = resolveContextAlias(contexts, context.name);
		map.set(alias, path.join(process.cwd(), 'src', 'app', context.name));
	}

	return map;
};

const resolveImportToFile = async (fromFile, importPath, aliasMap) => {
	const rawImport = String(importPath ?? '').trim();
	if (!rawImport.length) return null;

	let absolute = '';
	if (rawImport.startsWith('.')) {
		absolute = path.resolve(path.dirname(fromFile), rawImport);
	} else {
		const alias = Array.from(aliasMap.keys()).find((key) => rawImport === key || rawImport.startsWith(`${key}/`));
		if (!alias) return null;
		const suffix = rawImport === alias ? '' : rawImport.slice(alias.length + 1);
		absolute = path.join(aliasMap.get(alias), suffix);
	}

	const tsCandidate = absolute.endsWith('.ts') ? absolute : `${absolute}.ts`;
	try {
		await fs.access(tsCandidate);
		return tsCandidate;
	} catch {
		const indexCandidate = path.join(absolute, 'index.ts');
		try {
			await fs.access(indexCandidate);
			return indexCandidate;
		} catch {
			return null;
		}
	}
};

const extractSchemaTypeName = (content) => {
	const typeMatch = content.match(/=\s*[A-Za-z0-9_]+<\s*([^>]+?)\s*>\s*\(\)/m);
	if (!typeMatch) return null;
	return String(typeMatch[1]).trim();
};

const findTypeImportPath = (content, typeName) => {
	const importRegex = /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
	let match;
	while ((match = importRegex.exec(content)) !== null) {
		const imported = match[1]
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
		if (imported.includes(typeName)) {
			return match[2];
		}
	}
	return null;
};

const extractInterfaceBody = (content, interfaceName) => {
	const declarationRegex = new RegExp(`export\\s+interface\\s+${interfaceName}\\s*\\{`);
	const declarationMatch = content.match(declarationRegex);
	if (!declarationMatch || declarationMatch.index === undefined) return null;

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
	return content.slice(openBraceIndex + 1, closeBraceIndex);
};

const resolveRelativeExportPath = async (fromFile, exportPath) => {
	const absolute = path.resolve(path.dirname(fromFile), exportPath);
	const tsCandidate = absolute.endsWith('.ts') ? absolute : `${absolute}.ts`;
	try {
		await fs.access(tsCandidate);
		return tsCandidate;
	} catch {
		const indexCandidate = path.join(absolute, 'index.ts');
		try {
			await fs.access(indexCandidate);
			return indexCandidate;
		} catch {
			return null;
		}
	}
};

const findInterfaceBodyByExportGraph = async (entryFilePath, interfaceName, visited = new Set()) => {
	const resolvedPath = path.resolve(entryFilePath);
	if (visited.has(resolvedPath)) return null;
	visited.add(resolvedPath);

	let content = '';
	try {
		content = await fs.readFile(resolvedPath, 'utf-8');
	} catch {
		return null;
	}

	const direct = extractInterfaceBody(content, interfaceName);
	if (direct) return direct;

	const exportRegex = /export\\s+(?:\\*|\\{[^}]+\\})\\s+from\\s+['\"]([^'\"]+)['\"]/g;
	let match;
	while ((match = exportRegex.exec(content)) !== null) {
		const exportPath = match[1];
		if (!exportPath || !exportPath.startsWith('.')) continue;
		// eslint-disable-next-line no-await-in-loop
		const nextPath = await resolveRelativeExportPath(resolvedPath, exportPath);
		if (!nextPath) continue;
		// eslint-disable-next-line no-await-in-loop
		const nested = await findInterfaceBodyByExportGraph(nextPath, interfaceName, visited);
		if (nested) return nested;
	}

	return null;
};

const findInterfaceBodyByScan = async (rootDir, interfaceName) => {
	const queue = [rootDir];
	while (queue.length) {
		const current = queue.shift();
		if (!current) continue;
		let entries = [];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(absolute);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
			// eslint-disable-next-line no-await-in-loop
			const content = await fs.readFile(absolute, 'utf-8');
			const body = extractInterfaceBody(content, interfaceName);
			if (body) return body;
		}
	}
	return null;
};

const extractKeys = (body) => {
	const keys = [];
	const keyRegex = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm;
	let match;
	while ((match = keyRegex.exec(body)) !== null) {
		keys.push(match[1]);
	}
	return Array.from(new Set(keys));
};

const updateRulesObject = (schemaContent, keys) => {
	const rulesRegex = /\.rules\(\(rules\)\s*=>\s*\(\{([\s\S]*?)\}\)\)/m;
	const match = schemaContent.match(rulesRegex);
	if (!match) return null;

	const currentBody = match[1] ?? '';
	const existingKeys = new Set(extractKeys(currentBody));
	const newLines = keys.filter((key) => !existingKeys.has(key)).map((key) => `\t\t${key}: [],`);

	if (!newLines.length) return schemaContent;

	const trimmedBody = currentBody.trimEnd();
	const nextBody = trimmedBody.length ? `${trimmedBody}\n${newLines.join('\n')}\n\t` : `\n${newLines.join('\n')}\n\t`;

	return schemaContent.replace(rulesRegex, `.rules((rules) => ({${nextBody}}))`);
};

export default async function generateSchemaFromType() {
	const contextName = await selectContext('Select context for schema update:');
	if (!contextName) {
		process.exitCode = 1;
		return;
	}

	const presentationPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'presentation');
	const presenterFolders = await listDirectories(presentationPath);
	if (!presenterFolders.length) {
		console.error(`❌ No presenter folders found in ${presentationPath}`);
		process.exitCode = 1;
		return;
	}

	const { presenterFolder } = await prompts({
		type: 'select',
		name: 'presenterFolder',
		message: 'Select presenter folder:',
		choices: presenterFolders.map((item) => ({ title: item, value: item })),
		initial: 0
	});

	if (!presenterFolder) {
		process.exitCode = 1;
		return;
	}

	const schemaFolderPath = path.join(presentationPath, String(presenterFolder), 'schema');
	const schemas = await listSchemaFiles(schemaFolderPath);
	if (!schemas.length) {
		console.error(`❌ No schemas found in ${schemaFolderPath}`);
		process.exitCode = 1;
		return;
	}

	const { schemaFile } = await prompts({
		type: 'select',
		name: 'schemaFile',
		message: 'Select schema file:',
		choices: schemas.map((item) => ({ title: item, value: item })),
		initial: 0
	});

	if (!schemaFile) {
		process.exitCode = 1;
		return;
	}

	const schemaPath = path.join(schemaFolderPath, String(schemaFile));
	const schemaContent = await fs.readFile(schemaPath, 'utf-8');

	const typeName = extractSchemaTypeName(schemaContent);
	if (!typeName) {
		console.error('❌ Unable to resolve schema generic type.');
		process.exitCode = 1;
		return;
	}

	const importPath = findTypeImportPath(schemaContent, typeName);
	if (!importPath) {
		console.error(`❌ Unable to find import for type "${typeName}".`);
		process.exitCode = 1;
		return;
	}

	const aliasMap = await resolveAliasMap();
	const typeFilePath = await resolveImportToFile(schemaPath, importPath, aliasMap);
	if (!typeFilePath) {
		console.error(`❌ Unable to resolve type file path from import "${importPath}".`);
		process.exitCode = 1;
		return;
	}

	let interfaceBody = await findInterfaceBodyByExportGraph(typeFilePath, typeName);
	if (!interfaceBody) {
		interfaceBody = await findInterfaceBodyByScan(path.dirname(typeFilePath), typeName);
	}
	if (!interfaceBody) {
		console.error(`❌ Interface "${typeName}" not found in ${typeFilePath}`);
		process.exitCode = 1;
		return;
	}

	const interfaceKeys = extractKeys(interfaceBody);
	if (!interfaceKeys.length) {
		console.log('ℹ️ Interface has no explicit keys to transfer into rules.');
		return;
	}

	const updatedSchemaContent = updateRulesObject(schemaContent, interfaceKeys);
	if (!updatedSchemaContent) {
		console.error('❌ Could not locate `.rules((rules) => ({}))` block in schema file.');
		process.exitCode = 1;
		return;
	}

	if (updatedSchemaContent === schemaContent) {
		console.log('ℹ️ Rules already include all keys from type.');
		return;
	}

	await fs.writeFile(schemaPath, updatedSchemaContent, 'utf-8');
	console.log(`✅ Schema updated from type: ${schemaPath}`);
}
