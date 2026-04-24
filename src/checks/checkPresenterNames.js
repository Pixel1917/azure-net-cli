import fs from 'node:fs/promises';
import path from 'node:path';

const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);

const CREATE_FACTORY_PATTERN = '(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*createPresenterFactory\\s*\\(';
const IMPORT_FROM_PRESENTER_PATTERN = 'import\\s*\\{([^}]+)\\}\\s*from\\s*[\'"]([^\'"]+)[\'"]';
const PRESENTER_CALL_PATTERN = '\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(\\s*([\'"`])([^\'"`]*)\\2';

const toPosixPath = (value) => value.split(path.sep).join('/');

const isPresenterImportPath = (importPath) => {
	const normalized = importPath.replace(/\\/g, '/');
	return /(^|\/)presenter(\/|$)/.test(normalized);
};

const parseImportLocals = (rawImports) => {
	const locals = [];
	for (const segment of rawImports.split(',')) {
		const item = segment.trim();
		if (!item.length) continue;
		const aliasMatch = item.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
		if (aliasMatch?.[2]) {
			locals.push(aliasMatch[2]);
			continue;
		}

		const directMatch = item.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
		if (directMatch?.[1]) {
			locals.push(directMatch[1]);
		}
	}
	return locals;
};

const listSourceFiles = async (rootDir) => {
	const result = [];
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
			const fullPath = path.join(current, entry.name);
			const extension = path.extname(fullPath);
			if (!TARGET_EXTENSIONS.has(extension)) continue;
			result.push(fullPath);
		}
	}

	return result;
};

const getLineByIndex = (content, index) => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};

const extractFactoryNamesFromContent = (content) => {
	const createFactoryRegex = new RegExp(CREATE_FACTORY_PATTERN, 'g');
	const names = [];
	let match;
	while ((match = createFactoryRegex.exec(content)) !== null) {
		const name = match[1];
		if (name) names.push(name);
	}
	return names;
};

const extractImportedPresenterFactories = (content) => {
	const importFromPresenterRegex = new RegExp(IMPORT_FROM_PRESENTER_PATTERN, 'g');
	const names = [];
	let match;
	while ((match = importFromPresenterRegex.exec(content)) !== null) {
		const rawImports = match[1];
		const importPath = match[2];
		if (!rawImports || !importPath) continue;
		if (!isPresenterImportPath(importPath)) continue;
		names.push(...parseImportLocals(rawImports));
	}
	return names;
};

const collectPresenterOccurrences = (content, filePath, knownFactories) => {
	const presenterCallRegex = new RegExp(PRESENTER_CALL_PATTERN, 'g');
	const occurrences = [];
	const availableCallees = new Set(['createPresenter']);

	for (const name of extractFactoryNamesFromContent(content)) {
		availableCallees.add(name);
	}
	for (const name of extractImportedPresenterFactories(content)) {
		availableCallees.add(name);
	}
	for (const name of knownFactories) {
		availableCallees.add(name);
	}

	let match;
	while ((match = presenterCallRegex.exec(content)) !== null) {
		const callee = match[1];
		const quote = match[2];
		const presenterId = match[3];
		if (!callee || !presenterId) continue;
		if (!availableCallees.has(callee)) continue;
		if (quote === '`' && presenterId.includes('${')) continue;

		occurrences.push({
			id: presenterId,
			file: filePath,
			line: getLineByIndex(content, match.index),
			callee
		});
	}

	return occurrences;
};

export default async function checkPresenterNames() {
	const srcPath = path.join(process.cwd(), 'src');
	try {
		await fs.access(srcPath);
	} catch {
		console.error('❌ src folder not found in current workspace.');
		process.exitCode = 1;
		return;
	}

	const files = await listSourceFiles(srcPath);
	const fileContents = new Map();

	for (const filePath of files) {
		// eslint-disable-next-line no-await-in-loop
		const content = await fs.readFile(filePath, 'utf-8');
		fileContents.set(filePath, content);
	}

	const globalFactoryNames = new Set();
	for (const [filePath, content] of fileContents.entries()) {
		for (const name of extractFactoryNamesFromContent(content)) {
			globalFactoryNames.add(name);
		}
		if (filePath.endsWith(path.join('core', 'presenter', 'index.ts')) || filePath.endsWith(path.join('core', 'presenter', 'index.js'))) {
			for (const name of extractImportedPresenterFactories(content)) {
				globalFactoryNames.add(name);
			}
		}
	}

	const occurrences = [];
	for (const [filePath, content] of fileContents.entries()) {
		occurrences.push(...collectPresenterOccurrences(content, filePath, globalFactoryNames));
	}

	if (!occurrences.length) {
		console.log('✅ No presenter declarations found.');
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
		console.log(`✅ Presenter names are unique (${occurrences.length} found).`);
		return;
	}

	console.error('❌ Duplicate presenter names found:');
	for (const [presenterId, list] of duplicated) {
		console.error(`\n- "${presenterId}"`);
		for (const item of list) {
			console.error(`  • ${toPosixPath(path.relative(process.cwd(), item.file))}:${item.line} (${item.callee})`);
		}
	}

	process.exitCode = 1;
}
