import fs from 'fs/promises';
import path from 'path';

export async function writeIfNotExists(filepath: string, content: string): Promise<boolean> {
	try {
		await fs.access(filepath);
		console.log(`⚠️  Skip existing: ${filepath}`);
		return false;
	} catch {
		await fs.mkdir(path.dirname(filepath), { recursive: true });
		await fs.writeFile(filepath, content, 'utf-8');
		console.log(`✅ Created: ${filepath}`);
		return true;
	}
}

export async function updateIndexTs(dir: string, filePattern = '.ts', ignore: string[] = ['index.ts']): Promise<void> {
	try {
		const files = (await fs.readdir(dir)).filter((f) => f.endsWith(filePattern) && !ignore.includes(f));
		const content = files.map((f) => `export * from './${f.replace('.ts', '')}';`).join('\n') + '\n';
		await fs.writeFile(path.join(dir, 'index.ts'), content, 'utf-8');
	} catch {
		// Directory doesn't exist yet
	}
}

export async function updateCoreIndex(): Promise<void> {
	const corePath = path.join(process.cwd(), 'src/core');
	try {
		const dirs = await fs.readdir(corePath, { withFileTypes: true });
		const validDirs: string[] = [];

		for (const dir of dirs) {
			if (dir.isDirectory()) {
				// Check if directory has any files
				const dirPath = path.join(corePath, dir.name);
				const files = await fs.readdir(dirPath);
				if (files.length > 0) {
					validDirs.push(dir.name);
				}
			}
		}

		if (validDirs.length > 0) {
			const content = validDirs.map((d) => `export * from './${d}';`).join('\n') + '\n';
			await fs.writeFile(path.join(corePath, 'index.ts'), content, 'utf-8');
		}
	} catch {
		// Core directory doesn't exist
	}
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
