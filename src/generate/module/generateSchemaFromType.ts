import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { getConfigState, resolveContextAlias, selectContext } from './repositoryModuleShared.js';

const listDirectories = async (targetPath: string): Promise<string[]> => {
	try {
		const items = await fs.readdir(targetPath, { withFileTypes: true });
		return items.filter((item) => item.isDirectory()).map((item) => item.name);
	} catch {
		return [];
	}
};

const listSchemaFiles = async (targetPath: string): Promise<string[]> => {
	try {
		const files = await fs.readdir(targetPath);
		return files.filter((item) => item.endsWith('.ts') && item !== 'index.ts');
	} catch {
		return [];
	}
};

const resolveAliasMap = async (): Promise<Map<string, string>> => {
	const { contexts, coreAlias } = await getConfigState();
	const map = new Map<string, string>();
	map.set(coreAlias, path.join(process.cwd(), 'src', 'core'));

	for (const context of contexts) {
		const alias = resolveContextAlias(contexts, context.name);
		map.set(alias, path.join(process.cwd(), 'src', 'app', context.name));
	}

	return map;
};

const resolveImportToFile = async (fromFile: string, importPath: string, aliasMap: Map<string, string>): Promise<string | null> => {
	const rawImport = String(importPath ?? '').trim();
	if (!rawImport.length) return null;

	let absolute = '';
	if (rawImport.startsWith('.')) {
		absolute = path.resolve(path.dirname(fromFile), rawImport);
	} else {
		const alias = Array.from(aliasMap.keys()).find((key) => rawImport === key || rawImport.startsWith(`${key}/`));
		if (!alias) return null;
		const suffix = rawImport === alias ? '' : rawImport.slice(alias.length + 1);
		absolute = path.join(aliasMap.get(alias) as string, suffix);
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

const extractSchemaTypeName = (content: string): string | null => {
	const typeMatch = content.match(/=\s*[A-Za-z0-9_]+<\s*([^>]+?)\s*>\s*\(\)/m);
	if (!typeMatch) return null;
	return String(typeMatch[1]).trim();
};

const findTypeImportPath = (content: string, typeName: string): string | null => {
	const importRegex = /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;
	while ((match = importRegex.exec(content)) !== null) {
		const importedList = match[1];
		const sourcePath = match[2];
		if (!importedList || !sourcePath) continue;
		const imported = importedList
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
		if (imported.includes(typeName)) {
			return sourcePath;
		}
	}
	return null;
};

const extractInterfaceBody = (content: string, interfaceName: string): string | null => {
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

const resolveRelativeExportPath = async (fromFile: string, exportPath: string): Promise<string | null> => {
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

const findInterfaceBodyByExportGraph = async (
	entryFilePath: string,
	interfaceName: string,
	visited: Set<string> = new Set()
): Promise<string | null> => {
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

	const exportRegex = /export\s+(?:\*|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;
	while ((match = exportRegex.exec(content)) !== null) {
		const exportPath = match[1];
		if (!exportPath || !exportPath.startsWith('.')) continue;
		const nextPath = await resolveRelativeExportPath(resolvedPath, exportPath);
		if (!nextPath) continue;
		const nested = await findInterfaceBodyByExportGraph(nextPath, interfaceName, visited);
		if (nested) return nested;
	}

	return null;
};

const findInterfaceBodyByScan = async (rootDir: string, interfaceName: string): Promise<string | null> => {
	const queue: string[] = [rootDir];
	while (queue.length) {
		const current = queue.shift();
		if (!current) continue;
		let entries: import('node:fs').Dirent[] = [];
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
			const content = await fs.readFile(absolute, 'utf-8');
			const body = extractInterfaceBody(content, interfaceName);
			if (body) return body;
		}
	}
	return null;
};

const extractKeys = (body: string): string[] => {
	const keys: string[] = [];
	const keyRegex = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/gm;
	let match: RegExpExecArray | null;
	while ((match = keyRegex.exec(body)) !== null) {
		const key = match[1];
		if (key) keys.push(key);
	}
	return Array.from(new Set(keys));
};

const updateRulesObject = (schemaContent: string, keys: string[]): string | null => {
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

export default async function generateSchemaFromType(): Promise<void> {
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
