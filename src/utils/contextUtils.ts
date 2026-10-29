import fs from 'node:fs/promises';
import { normalizePascalName } from './architecture.js';
export {
	getContextPath,
	selectContext,
	selectPresentationWorkspace,
	discoverContexts,
	discoverPresentationWorkspaces,
	normalizePascalName
} from './architecture.js';

export async function getAvailableFiles(dir: string, pattern = '.ts'): Promise<string[]> {
	try {
		return (await fs.readdir(dir))
			.filter((file) => file.endsWith(pattern) && file !== 'index.ts')
			.map((file) => file.slice(0, -pattern.length));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

export function toPascalCase(str: string): string {
	return str.trim() ? normalizePascalName(str) : '';
}
export function toCamelCase(str: string): string {
	const pascal = toPascalCase(str);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
export function toKebabCase(str: string): string {
	return str
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
		.toLowerCase();
}
