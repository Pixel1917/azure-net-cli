import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeContexts } from '../init/initAliases.js';
import { loadUserConfig } from '../utils/loadConfig.js';
const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);
const LAYERS = ['domain', 'application', 'infrastructure', 'presentation'];
const FORBIDDEN_LAYER_IMPORTS = {
	infrastructure: ['application', 'presentation'],
	application: ['presentation'],
	domain: ['application', 'infrastructure', 'presentation'],
	presentation: []
};
const IMPORT_FROM_PATTERN = /\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_PATTERN = /\bexport\s+(?:type\s+)?\{[\s\S]*?\}\sfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const toPosixPath = (value) => value.split(path.sep).join('/');
const findLineByIndex = (content, index) => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};
const getRelativePath = (filePath) => toPosixPath(path.relative(process.cwd(), filePath));
const listFiles = async (rootDir) => {
	const files = [];
	const stack = [rootDir];
	while (stack.length) {
		const current = stack.pop();
		if (!current) continue;
		let entries = [];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) {
					stack.push(path.join(current, entry.name));
				}
				continue;
			}
			if (!entry.isFile()) continue;
			const filePath = path.join(current, entry.name);
			if (!TARGET_EXTENSIONS.has(path.extname(filePath))) continue;
			files.push(filePath);
		}
	}
	return files;
};
const extractImports = (content) => {
	const matches = [];
	const patterns = [IMPORT_FROM_PATTERN, EXPORT_FROM_PATTERN, DYNAMIC_IMPORT_PATTERN];
	for (const pattern of patterns) {
		const regex = new RegExp(pattern.source, 'g');
		let match;
		while ((match = regex.exec(content)) !== null) {
			const value = match[1];
			if (!value) continue;
			matches.push({ value, line: findLineByIndex(content, match.index) });
		}
	}
	return matches;
};
const getLayerFromPath = (filePath, contextRoot) => {
	for (const layer of LAYERS) {
		const layerRoot = path.join(contextRoot, 'layers', layer);
		if (filePath === layerRoot || filePath.startsWith(`${layerRoot}${path.sep}`)) {
			return layer;
		}
	}
	return null;
};
const getLayerFromAliasImport = (importPath, context) => {
	if (importPath !== context.alias && !importPath.startsWith(`${context.alias}/`)) return null;
	const withoutAlias = importPath.slice(context.alias.length).replace(/^\/+/, '');
	for (const layer of LAYERS) {
		if (withoutAlias === `layers/${layer}` || withoutAlias.startsWith(`layers/${layer}/`)) return layer;
		if (withoutAlias === layer || withoutAlias.startsWith(`${layer}/`)) return layer;
	}
	return null;
};
const getLayerFromRelativeImport = (filePath, importPath, contextRoot) => {
	if (!importPath.startsWith('.')) return null;
	const absoluteImportPath = path.resolve(path.dirname(filePath), importPath);
	return getLayerFromPath(absoluteImportPath, contextRoot);
};
const createMessage = (sourceLayer, targetLayer, context) =>
	`Layer import violation: "${context.name}" ${sourceLayer} layer cannot import from ${targetLayer} layer`;
export default async function checkLayerImports() {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);
	if (!contexts.length) {
		console.error('❌ No contexts found in azure-net.config.ts/js. Fill `contexts` first.');
		process.exitCode = 1;
		return;
	}
	const issues = [];
	for (const context of contexts) {
		const contextRoot = path.join(process.cwd(), 'src', 'app', context.name);
		try {
			await fs.access(contextRoot);
		} catch {
			continue;
		}
		const files = await listFiles(path.join(contextRoot, 'layers'));
		for (const filePath of files) {
			const sourceLayer = getLayerFromPath(filePath, contextRoot);
			if (!sourceLayer) continue;
			const forbiddenLayers = FORBIDDEN_LAYER_IMPORTS[sourceLayer];
			if (!forbiddenLayers.length) continue;
			const content = await fs.readFile(filePath, 'utf-8');
			const imports = extractImports(content);
			for (const entry of imports) {
				const targetLayer = getLayerFromAliasImport(entry.value, context) ?? getLayerFromRelativeImport(filePath, entry.value, contextRoot);
				if (!targetLayer || !forbiddenLayers.includes(targetLayer)) continue;
				issues.push({
					file: filePath,
					line: entry.line,
					message: createMessage(sourceLayer, targetLayer, context)
				});
			}
		}
	}
	if (!issues.length) {
		console.log('✅ Layer imports check passed.');
		return;
	}
	console.error('❌ Layer imports check failed:');
	for (const issue of issues) {
		console.error(`• ${getRelativePath(issue.file)}:${issue.line} — ${issue.message}`);
	}
	process.exitCode = 1;
}
