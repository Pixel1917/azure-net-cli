import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';
import { normalizeContexts } from '../init/initAliases.js';

const ALLOWED_LAYERS_FOLDERS = new Set(['domain', 'presentation', 'infrastructure', 'application']);
const ALLOWED_UI_FOLDERS = new Set(['components', 'widgets', 'design', 'style']);
const ALLOWED_COMPONENTS_FOLDERS = new Set(['page', 'layout', 'shared']);

const toPosixPath = (value) => value.split(path.sep).join('/');

const getRelativePath = (filePath) => toPosixPath(path.relative(process.cwd(), filePath));

const getDirectories = async (dirPath) => {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return null;
	}
};

const checkOnlyAllowedFolders = async (basePath, allowed, scopeLabel, issues) => {
	const directories = await getDirectories(basePath);
	if (!directories) return;

	for (const dir of directories) {
		if (allowed.has(dir)) continue;
		issues.push({
			file: basePath,
			message: `${scopeLabel} can contain only: ${Array.from(allowed).join(', ')}. Found: ${dir}`
		});
	}
};

export default async function checkFoldersStructure() {
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
		const layersPath = path.join(contextRoot, 'layers');
		const uiPath = path.join(contextRoot, 'ui');
		const componentsPath = path.join(uiPath, 'components');

		await checkOnlyAllowedFolders(layersPath, ALLOWED_LAYERS_FOLDERS, `layers (${context.name})`, issues);
		await checkOnlyAllowedFolders(uiPath, ALLOWED_UI_FOLDERS, `ui (${context.name})`, issues);
		await checkOnlyAllowedFolders(componentsPath, ALLOWED_COMPONENTS_FOLDERS, `ui/components (${context.name})`, issues);
	}

	if (!issues.length) {
		console.log('✅ Folders structure check passed.');
		return;
	}

	console.error('❌ Folders structure check failed:');
	for (const issue of issues) {
		console.error(`• ${getRelativePath(issue.file)} — ${issue.message}`);
	}

	process.exitCode = 1;
}
