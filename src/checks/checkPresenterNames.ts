import fs from 'node:fs/promises';
import path from 'node:path';

type PresenterOccurrence = {
	id: string;
	file: string;
	line: number;
	callee: string;
};

const TARGET_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git']);

const CREATE_FACTORY_PATTERN = '(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*createPresenterFactory\\s*\\(';
const IMPORT_FROM_PRESENTER_PATTERN = 'import\\s*\\{([^}]+)\\}\\s*from\\s*[\'"]([^\'"]+)[\'"]';
const PRESENTER_CALL_PATTERN = '\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(\\s*([\'"`])([^\'"`]*)\\2';

const toPosixPath = (value: string): string => value.split(path.sep).join('/');

const isPresenterImportPath = (importPath: string): boolean => {
	const normalized = importPath.replace(/\\/g, '/');
	return /(^|\/)presenter(\/|$)/.test(normalized);
};

const parseImportLocals = (rawImports: string): string[] => {
	const locals: string[] = [];
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

const listSourceFiles = async (rootDir: string): Promise<string[]> => {
	const result: string[] = [];
	const stack: string[] = [rootDir];

	while (stack.length) {
		const current = stack.pop();
		if (!current) continue;

		let entries: import('node:fs').Dirent[] = [];
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

const getLineByIndex = (content: string, index: number): number => {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (content[i] === '\n') line += 1;
	}
	return line;
};

const extractFactoryNamesFromContent = (content: string): string[] => {
	const createFactoryRegex = new RegExp(CREATE_FACTORY_PATTERN, 'g');
	const names: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = createFactoryRegex.exec(content)) !== null) {
		const name = match[1];
		if (name) names.push(name);
	}
	return names;
};

const extractImportedPresenterFactories = (content: string): string[] => {
	const importFromPresenterRegex = new RegExp(IMPORT_FROM_PRESENTER_PATTERN, 'g');
	const names: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = importFromPresenterRegex.exec(content)) !== null) {
		const rawImports = match[1];
		const importPath = match[2];
		if (!rawImports || !importPath) continue;
		if (!isPresenterImportPath(importPath)) continue;
		names.push(...parseImportLocals(rawImports));
	}
	return names;
};

const collectPresenterOccurrences = (content: string, filePath: string, knownFactories: Set<string>): PresenterOccurrence[] => {
	const presenterCallRegex = new RegExp(PRESENTER_CALL_PATTERN, 'g');
	const occurrences: PresenterOccurrence[] = [];
	const availableCallees = new Set<string>(['createPresenter']);

	for (const name of extractFactoryNamesFromContent(content)) {
		availableCallees.add(name);
	}
	for (const name of extractImportedPresenterFactories(content)) {
		availableCallees.add(name);
	}
	for (const name of knownFactories) {
		availableCallees.add(name);
	}

	let match: RegExpExecArray | null;
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

export default async function checkPresenterNames(): Promise<void> {
	const srcPath = path.join(process.cwd(), 'src');
	try {
		await fs.access(srcPath);
	} catch {
		console.error('❌ src folder not found in current workspace.');
		process.exitCode = 1;
		return;
	}

	const files = await listSourceFiles(srcPath);
	const fileContents = new Map<string, string>();

	for (const filePath of files) {
		const content = await fs.readFile(filePath, 'utf-8');
		fileContents.set(filePath, content);
	}

	const globalFactoryNames = new Set<string>();
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

	const occurrences: PresenterOccurrence[] = [];
	for (const [filePath, content] of fileContents.entries()) {
		occurrences.push(...collectPresenterOccurrences(content, filePath, globalFactoryNames));
	}

	if (!occurrences.length) {
		console.log('✅ No presenter declarations found.');
		return;
	}

	const grouped = new Map<string, PresenterOccurrence[]>();
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
