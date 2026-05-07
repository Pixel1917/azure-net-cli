import fs from 'node:fs/promises';
import path from 'node:path';
const TARGET_EXTENSIONS = new Set(['.ts', '.js']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);
const toPosixPath = (value) => value.split(path.sep).join('/');
const getLineByIndex = (content, index) => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};
const listSourceFiles = async (rootDir) => {
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
				if (!IGNORED_DIRS.has(entry.name)) stack.push(path.join(current, entry.name));
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
const findMatchingBracket = (content, startIndex, openChar, closeChar) => {
	let depth = 0;
	for (let i = startIndex; i < content.length; i += 1) {
		const ch = content[i];
		if (ch === openChar) depth += 1;
		if (ch === closeChar) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
};
const extractDependsOn = (configBlock) => {
	const dependsOnMatch = configBlock.match(/dependsOn\s*:\s*\{([\s\S]*?)\}/m);
	if (!dependsOnMatch?.[1]) return [];
	const block = dependsOnMatch[1];
	const deps = new Set();
	const keyRegex = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g;
	let match;
	while ((match = keyRegex.exec(block)) !== null) {
		const key = match[1];
		if (key) deps.add(key);
	}
	return [...deps];
};
const parseProviderGraphFromFile = (content, filePath) => {
	const nodes = [];
	const token = 'createBoundaryProvider(';
	let fromIndex = 0;
	while (fromIndex < content.length) {
		const start = content.indexOf(token, fromIndex);
		if (start === -1) break;
		const openParenIndex = start + token.length - 1;
		const closeParenIndex = findMatchingBracket(content, openParenIndex, '(', ')');
		if (closeParenIndex === -1) break;
		const fullCall = content.slice(openParenIndex + 1, closeParenIndex);
		const idMatch = fullCall.match(/^\s*(['"`])([^'"`]+)\1\s*,/m);
		const providerName = idMatch?.[2];
		if (providerName) {
			const objectStartInCall = fullCall.indexOf('{');
			if (objectStartInCall !== -1) {
				const absoluteObjectStart = openParenIndex + 1 + objectStartInCall;
				const absoluteObjectEnd = findMatchingBracket(content, absoluteObjectStart, '{', '}');
				const configBlock =
					absoluteObjectEnd !== -1 ? content.slice(absoluteObjectStart, absoluteObjectEnd + 1) : fullCall.slice(objectStartInCall);
				nodes.push({
					name: providerName,
					file: filePath,
					line: getLineByIndex(content, start),
					dependsOn: extractDependsOn(configBlock)
				});
			} else {
				nodes.push({
					name: providerName,
					file: filePath,
					line: getLineByIndex(content, start),
					dependsOn: []
				});
			}
		}
		fromIndex = closeParenIndex + 1;
	}
	return nodes;
};
const findCycles = (graph) => {
	const cycles = [];
	const visited = new Set();
	const inStack = new Set();
	const stack = [];
	const dfs = (node) => {
		visited.add(node);
		inStack.add(node);
		stack.push(node);
		const neighbors = graph.get(node) ?? [];
		for (const next of neighbors) {
			if (!graph.has(next)) continue;
			if (!visited.has(next)) {
				dfs(next);
				continue;
			}
			if (inStack.has(next)) {
				const idx = stack.indexOf(next);
				if (idx !== -1) cycles.push([...stack.slice(idx), next]);
			}
		}
		stack.pop();
		inStack.delete(node);
	};
	for (const node of graph.keys()) {
		if (!visited.has(node)) dfs(node);
	}
	return cycles;
};
export default async function checkProviderGraph() {
	const srcPath = path.join(process.cwd(), 'src');
	try {
		await fs.access(srcPath);
	} catch {
		console.error('❌ src folder not found in current workspace.');
		process.exitCode = 1;
		return;
	}
	const files = await listSourceFiles(srcPath);
	const providers = [];
	for (const filePath of files) {
		const content = await fs.readFile(filePath, 'utf-8');
		providers.push(...parseProviderGraphFromFile(content, filePath));
	}
	if (!providers.length) {
		console.log('✅ No createBoundaryProvider declarations found.');
		return;
	}
	const graph = new Map();
	const issues = [];
	const byName = new Map();
	for (const provider of providers) {
		if (byName.has(provider.name)) {
			const existing = byName.get(provider.name);
			issues.push({
				file: provider.file,
				line: provider.line,
				message: `Provider graph ambiguity: duplicate provider id "${provider.name}" (first declared at ${toPosixPath(path.relative(process.cwd(), existing.file))}:${existing.line})`
			});
			continue;
		}
		byName.set(provider.name, provider);
		graph.set(provider.name, provider.dependsOn);
	}
	const cycles = findCycles(graph);
	for (const cycle of cycles) {
		const firstNode = byName.get(cycle[0] ?? '');
		issues.push({
			file: firstNode?.file ?? srcPath,
			line: firstNode?.line ?? 1,
			message: `Circular provider dependency detected: ${cycle.join(' -> ')}`
		});
	}
	if (!issues.length) {
		console.log(`✅ Provider graph check passed (${providers.length} providers).`);
		return;
	}
	console.error('❌ Provider graph check failed:');
	for (const issue of issues) {
		console.error(`• ${toPosixPath(path.relative(process.cwd(), issue.file))}:${issue.line} — ${issue.message}`);
	}
	process.exitCode = 1;
}
