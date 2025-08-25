import fs from 'fs/promises';
import path from 'path';

export async function writeIfNotExists(filepath, content) {
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

export async function updateIndexTs(dir, filePattern = '.ts', ignore = ['index.ts']) {
    try {
        const files = (await fs.readdir(dir)).filter(f =>
            f.endsWith(filePattern) && !ignore.includes(f)
        );
        const content = files
            .map(f => `export * from './${f.replace('.ts', '')}';`)
            .join('\n') + '\n';
        await fs.writeFile(path.join(dir, 'index.ts'), content, 'utf-8');
    } catch (error) {
        // Directory doesn't exist yet
    }
}

export async function ensureIndexExports(layerPath) {
    try {
        const subdirs = await fs.readdir(layerPath, { withFileTypes: true });
        const exportLines = subdirs
            .filter(d => d.isDirectory())
            .map(d => `export * from './${d.name}';`);

        if (exportLines.length > 0) {
            await fs.writeFile(
                path.join(layerPath, 'index.ts'),
                exportLines.join('\n') + '\n',
                'utf-8'
            );
        }
    } catch (error) {
        // Directory doesn't exist
    }
}

export async function injectIntoFile(filepath, searchPattern, newContent, position = 'after') {
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
    } catch (error) {
        console.error(`Failed to update ${filepath}:`, error.message);
        return false;
    }
}