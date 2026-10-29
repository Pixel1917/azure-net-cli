import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig, resolveConfigFile } from '../utils/loadConfig.js';
import { updateDefaultFactoryConfig } from '../scaffolds/updateDefaultFactoryConfig.js';

/** Preserve explicit settings; otherwise prefer package.json, then lockfiles. */
export default async function configurePackageManager(): Promise<void> {
	if ((await loadUserConfig()).packageManager) return;
	let manager: string | undefined;
	try {
		const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { packageManager?: string };
		manager = pkg.packageManager?.split('@')[0];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	if (!manager || !['pnpm', 'npm', 'yarn', 'bun'].includes(manager)) {
		manager = 'npm';
		for (const [file, candidate] of [
			['pnpm-lock.yaml', 'pnpm'],
			['yarn.lock', 'yarn'],
			['bun.lock', 'bun'],
			['bun.lockb', 'bun'],
			['package-lock.json', 'npm']
		] as const) {
			try {
				await fs.access(file);
				manager = candidate;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
	}
	const config = resolveConfigFile();
	const source = config.exists ? await fs.readFile(config.filepath, 'utf8') : '';
	await fs.writeFile(config.filepath, updateDefaultFactoryConfig(source, 'packageManager', manager));
	console.log(`Package manager: ${manager}. Existing packages unchanged.`);
}
