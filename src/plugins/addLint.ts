import fs from 'node:fs';
import path from 'node:path';

interface AddLintOptions {
	manager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
}

export default async function addLint(_options: AddLintOptions = {}): Promise<void> {
	// Retain compatibility with the existing --manager option without running a package manager.
	void _options;
	const cwd = process.cwd();
	const pkgPath = path.join(cwd, 'package.json');
	if (!fs.existsSync(pkgPath)) throw new Error('package.json not found in this directory');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
	const configNames = [
		'.prettierrc',
		'.prettierrc.json',
		'.prettierrc.json5',
		'.prettierrc.yaml',
		'.prettierrc.yml',
		'.prettierrc.toml',
		'.prettierrc.js',
		'.prettierrc.cjs',
		'.prettierrc.mjs',
		'.prettierrc.ts',
		'.prettierrc.cts',
		'.prettierrc.mts',
		'prettier.config.js',
		'prettier.config.cjs',
		'prettier.config.mjs',
		'prettier.config.ts',
		'prettier.config.cts',
		'prettier.config.mts'
	];
	const existingConfigs = configNames.filter((name) => fs.existsSync(path.join(cwd, name)));
	if ('prettier' in pkg || existingConfigs.length) {
		const backupRoot = path.join(cwd, '.azure-net', 'PrettierBackups');
		fs.mkdirSync(backupRoot, { recursive: true });
		// Atomic directory creation prevents overwriting backups from rapid repeated runs.
		const backup = fs.mkdtempSync(path.join(backupRoot, 'config-'));
		if ('prettier' in pkg) {
			fs.copyFileSync(pkgPath, path.join(backup, 'package.json'), fs.constants.COPYFILE_EXCL);
			delete pkg.prettier;
			fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
		}
		for (const name of existingConfigs) {
			fs.renameSync(path.join(cwd, name), path.join(backup, name));
		}
	}
	fs.writeFileSync(
		path.join(cwd, '.prettierrc'),
		JSON.stringify(
			{
				useTabs: true,
				singleQuote: true,
				trailingComma: 'none',
				tabWidth: 2,
				semi: true,
				printWidth: 150
			},
			null,
			'\t'
		) + '\n'
	);
	console.log('Prettier configuration replaced. No packages installed.');
}
