import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists } from './fileUtils.js';

export const SHARED_CONTEXT = 'SharedKernel';
export const SHARED_WORKSPACE = 'Shared';
export const ARCHITECTURE_ALIASES = {
	'#contexts': './src/app/Contexts',
	'#presentation': './src/app/Presentation',
	'#platform': './src/app/Platform'
} as const;
export const CONTEXT_DIRS = [
	'Domain/Entities',
	'Domain/Ports',
	'Domain/Enums',
	'Application/UseCases',
	'Infrastructure/Repositories'
] as const;
export const PRESENTATION_DIRS = ['Ui', 'Scopes', 'Shell'] as const;

export function normalizePascalName(value: string): string {
	const raw = value.trim();
	if (!/^[A-Za-z][A-Za-z0-9 _-]*$/.test(raw))
		throw new Error(`Invalid architecture name: "${value}". Use letters, numbers, spaces, hyphens or underscores.`);
	return raw
		.split(/[-_\s]+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

export const getAppPath = (cwd = process.cwd()): string => path.join(cwd, 'src', 'app');
export const getContextsPath = (cwd = process.cwd()): string => path.join(getAppPath(cwd), 'Contexts');
export const getContextPath = (context: string, cwd = process.cwd()): string =>
	path.join(getContextsPath(cwd), normalizePascalName(context));
export const getPresentationPath = (workspace?: string, cwd = process.cwd()): string =>
	workspace ? path.join(getAppPath(cwd), 'Presentation', normalizePascalName(workspace)) : path.join(getAppPath(cwd), 'Presentation');
export const getPlatformPath = (cwd = process.cwd()): string => path.join(getAppPath(cwd), 'Platform');
export const getContextImportPath = (context: string): string => `#contexts/${normalizePascalName(context)}`;
export const getPresentationImportPath = (workspace?: string): string =>
	workspace ? `#presentation/${normalizePascalName(workspace)}` : '#presentation';

async function directories(root: string): Promise<string[]> {
	try {
		return (await fs.readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

export const discoverContexts = async (cwd = process.cwd()): Promise<string[]> =>
	(await directories(getContextsPath(cwd))).filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name));
export const discoverPresentationWorkspaces = async (cwd = process.cwd()): Promise<string[]> =>
	(await directories(getPresentationPath(undefined, cwd))).filter(
		(name) => !PRESENTATION_DIRS.includes(name as (typeof PRESENTATION_DIRS)[number]) && /^[A-Z][A-Za-z0-9]*$/.test(name)
	);

export async function ensureContextStructure(context: string, cwd = process.cwd()): Promise<string> {
	const name = normalizePascalName(context);
	for (const dir of CONTEXT_DIRS) {
		await writeIfNotExists(path.join(getContextPath(name, cwd), dir, 'index.ts'), 'export {};\n');
	}
	return name;
}

export async function ensurePresentationStructure(workspace?: string, cwd = process.cwd()): Promise<void> {
	for (const dir of PRESENTATION_DIRS) await fs.mkdir(path.join(getPresentationPath(workspace, cwd), dir), { recursive: true });
}

export async function selectContext(message = 'Select context:'): Promise<string | null> {
	await ensureContextStructure(SHARED_CONTEXT);
	const names = await discoverContexts();
	const result = await prompts({
		type: 'select',
		name: 'context',
		message,
		choices: [...names.map((name) => ({ title: name, value: name })), { title: 'Create new context', value: '__create__' }]
	});
	if (!result.context) return null;
	if (result.context !== '__create__') return String(result.context);
	const answer = await prompts({
		type: 'text',
		name: 'name',
		message: 'Context name:',
		validate: (value: string) => {
			try {
				normalizePascalName(value);
				return true;
			} catch (error) {
				return (error as Error).message;
			}
		}
	});
	return answer.name ? ensureContextStructure(String(answer.name)) : null;
}

/** null means cancelled; undefined means the flat Presentation layout. */
export async function selectPresentationWorkspace(message = 'Select presentation workspace:'): Promise<string | null | undefined> {
	const workspaces = await discoverPresentationWorkspaces();
	if (!workspaces.length) return undefined;
	await ensurePresentationStructure(SHARED_WORKSPACE);
	if (!workspaces.includes(SHARED_WORKSPACE)) workspaces.push(SHARED_WORKSPACE);
	const answer = await prompts({
		type: 'select',
		name: 'workspace',
		message,
		choices: workspaces.sort().map((name) => ({ title: name, value: name }))
	});
	return answer.workspace ? String(answer.workspace) : null;
}

export type PresentationWorkspace = { name: string; path: string; alias: string };
export async function selectWorkspace(): Promise<PresentationWorkspace | null> {
	const name = await selectPresentationWorkspace();
	if (name === null) return null;
	return { name: name ?? '', path: getPresentationPath(name), alias: getPresentationImportPath(name) };
}

export async function selectScope(workspace: PresentationWorkspace): Promise<string | null> {
	const root = path.join(workspace.path, 'Scopes');
	const scopes = (await directories(root)).filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name));
	const answer = await prompts({
		type: 'select',
		name: 'scope',
		message: 'Select scope:',
		choices: [...scopes.map((name) => ({ title: name, value: name })), { title: 'Create new scope', value: '__create__' }]
	});
	if (!answer.scope) return null;
	if (answer.scope !== '__create__') return String(answer.scope);
	const created = await prompts({
		type: 'text',
		name: 'name',
		message: 'Scope name:',
		validate: (value: string) => {
			try {
				normalizePascalName(value);
				return true;
			} catch (error) {
				return (error as Error).message;
			}
		}
	});
	if (!created.name) return null;
	const name = normalizePascalName(String(created.name));
	await fs.mkdir(path.join(root, name), { recursive: true });
	return name;
}
