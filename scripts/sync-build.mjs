import fs from 'node:fs/promises';
import path from 'node:path';
async function sync(directory) {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const source = path.join(directory, entry.name);
		if (entry.isDirectory()) await sync(source);
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			const target = source.slice(0, -3) + '.js';
			const content = (await fs.readFile(path.join('dist', target), 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/gm, '');
			await fs.writeFile(target, content);
		}
	}
}
await sync('src');
await sync('bin');
await fs.chmod('bin/azure-net.js', 0o755);
