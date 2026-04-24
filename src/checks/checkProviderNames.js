import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);
const IMPORT_PATTERN = 'import\\s*\\{([^}]+)\\}\\s*from\\s*[\'"]([^\'"]+)[\'"]';
const CALL_PATTERN = '\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(\\s*([\'"`])([^\'"`]*)\\2';

const toPosixPath = (value) => value.split(path.sep).join('/');

const parseImportAliases = (rawImports, importName) => {
	const aliases = [];
	for (const segment of rawImports.split(',')) {
		const item = segment.trim();
		if (!item.length) continue;

		const aliasMatch = item.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
		if (aliasMatch?.[1] === importName && aliasMatch[2]) {
			aliases.push(aliasMatch[2]);
			continue;
		}

		if (item === importName) {
			aliases.push(importName);
		}
	}
	return aliases;
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
				if (!IGNORED_DIRS.has(entry.name)) {
					stack.push(path.join(current, entry.name));
				}
				continue;
			}

			if (!entry.isFile()) continue;
			const filepath = path.join(current, entry.name);
			if (!TARGET_EXTENSIONS.has(path.extname(filepath))) continue;
			files.push(filepath);
		}
	}

	return files;
};

const getLineByIndex = (content, index) => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};

const extractBoundaryFactoryAliases = (content) => {
	const importRegex = new RegExp(IMPORT_PATTERN, 'g');
	const aliases = new Set(['createBoundaryProvider']);
	let match;

	while ((match = importRegex.exec(content)) !== null) {
		const rawImports = match[1];
		if (!rawImports) continue;
		for (const alias of parseImportAliases(rawImports, 'createBoundaryProvider')) {
			aliases.add(alias);
		}
	}

	return aliases;
};

const collectProviderOccurrences = (content, filepath) => {
	const aliases = extractBoundaryFactoryAliases(content);
	const callRegex = new RegExp(CALL_PATTERN, 'g');
	const occurrences = [];
	let match;

	while ((match = callRegex.exec(content)) !== null) {
		const callee = match[1];
		const quote = match[2];
		const providerId = match[3];

		if (!callee || !providerId) continue;
		if (!aliases.has(callee)) continue;
		if (quote === '`' && providerId.includes('${')) continue;

		occurrences.push({
			id: providerId,
			file: filepath,
			line: getLineByIndex(content, match.index),
			callee
		});
	}

	return occurrences;
};

export default async function checkProviderNames() {
	const srcPath = path.join(process.cwd(), 'src');
	try {
		await fs.access(srcPath);
	} catch {
		console.error('❌ src folder not found in current workspace.');
		process.exitCode = 1;
		return;
	}

	const files = await listSourceFiles(srcPath);
	const occurrences = [];

	for (const filepath of files) {
		const content = await fs.readFile(filepath, 'utf-8');
		occurrences.push(...collectProviderOccurrences(content, filepath));
	}

	if (!occurrences.length) {
		console.log('✅ No providers declarations found.');
		return;
	}

	const grouped = new Map();
	for (const occurrence of occurrences) {
		const list = grouped.get(occurrence.id) ?? [];
		list.push(occurrence);
		grouped.set(occurrence.id, list);
	}

	const duplicated = Array.from(grouped.entries()).filter(([, list]) => list.length > 1);
	if (!duplicated.length) {
		console.log(`✅ Provider names are unique (${occurrences.length} found).`);
		return;
	}

	console.error('❌ Duplicate provider names found:');
	for (const [providerId, list] of duplicated) {
		console.error(`\n- "${providerId}"`);
		for (const item of list) {
			console.error(`  • ${toPosixPath(path.relative(process.cwd(), item.file))}:${item.line} (${item.callee})`);
		}
	}

	process.exitCode = 1;
}
