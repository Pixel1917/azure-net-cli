import fs from 'fs/promises';
import path from 'path';

export async function writeIfNotExists(filepath: string, content: string): Promise<boolean> {
	await fs.mkdir(path.dirname(filepath), { recursive: true });
	try {
		await fs.writeFile(filepath, content, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		console.log(`Skip existing: ${filepath}`);
		return false;
	}
	console.log(`Created: ${filepath}`);
	return true;
}

export async function appendBarrelExports(filepath: string, sources: string[]): Promise<void> {
	let content = '';
	try {
		content = await fs.readFile(filepath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const additions = sources
		.filter((source) => !content.includes("from '" + source + "'") && !content.includes('from "' + source + '"'))
		.map((source) => 'export * from ' + JSON.stringify(source) + ';');
	if (!additions.length && content.trim()) return;
	await fs.mkdir(path.dirname(filepath), { recursive: true });
	await fs.writeFile(
		filepath,
		content + (content && !content.endsWith('\n') ? '\n' : '') + (additions.length ? additions.join('\n') : 'export {};') + '\n'
	);
}

export async function updateIndexTs(dir: string, filePattern = '.ts', ignore: string[] = ['index.ts']): Promise<void> {
	const files = (await fs.readdir(dir))
		.filter((file) => file.endsWith(filePattern) && !file.endsWith('.d.ts') && !ignore.includes(file))
		.sort();
	await appendBarrelExports(
		path.join(dir, 'index.ts'),
		files.map((file) => './' + file.slice(0, -filePattern.length))
	);
}

export async function ensureIndexExports(layerPath: string): Promise<void> {
	try {
		const subdirs = await fs.readdir(layerPath, { withFileTypes: true });
		const exportLines = subdirs.filter((d) => d.isDirectory()).map((d) => `export * from './${d.name}';`);

		if (exportLines.length > 0) {
			await fs.writeFile(path.join(layerPath, 'index.ts'), exportLines.join('\n') + '\n', 'utf-8');
		}
	} catch {
		// Directory doesn't exist
	}
}

export async function injectIntoFile(
	filepath: string,
	searchPattern: string,
	newContent: string,
	position: 'after' | 'before' = 'after'
): Promise<boolean> {
	try {
		let content = await fs.readFile(filepath, 'utf-8');
		const index = content.indexOf(searchPattern);

		if (index === -1) {
			console.warn(`Pattern not found in ${filepath}`);
			return false;
		}

		if (content.includes(newContent.trim())) {
			console.log(`Content already exists in ${filepath}`);
			return false;
		}

		if (position === 'after') {
			const insertIndex = index + searchPattern.length;
			content = content.slice(0, insertIndex) + '\n' + newContent + content.slice(insertIndex);
		} else {
			content = content.slice(0, index) + newContent + '\n' + content.slice(index);
		}

		await fs.writeFile(filepath, content, 'utf-8');
		console.log(`✅ Updated: ${filepath}`);
		return true;
	} catch (error: unknown) {
		console.error(`Failed to update ${filepath}:`, error instanceof Error ? error.message : String(error));
		return false;
	}
}
