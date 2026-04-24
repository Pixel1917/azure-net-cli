import { execSync } from 'node:child_process';
import { loadUserConfig } from '../utils/loadConfig.js';
import checkInternal from './checkInternal.js';

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

const isPackageManager = (value: unknown): value is PackageManager =>
	typeof value === 'string' && ['pnpm', 'npm', 'yarn', 'bun'].includes(value);

const runScript = (manager: PackageManager, script: string): void => {
	const command = `${manager} run ${script}`;
	console.log(`\n▶ Running: ${command}`);
	execSync(command, { stdio: 'inherit' });
};

const runInternalChecks = async (): Promise<void> => {
	console.log('\n▶ Running: azure-net check internal');
	process.exitCode = 0;
	await checkInternal();
	if ((process.exitCode ?? 0) !== 0) {
		throw new Error('azure-net check internal failed');
	}
};

export default async function checkProject(): Promise<void> {
	const config = await loadUserConfig();
	const manager = config.packageManager;

	if (!isPackageManager(manager)) {
		console.error('❌ packageManager is missing or invalid in azure-net.config.ts/js. Use one of: bun, pnpm, npm, yarn');
		process.exitCode = 1;
		return;
	}

	try {
		runScript(manager, 'format');
		await runInternalChecks();
		runScript(manager, 'lint');
		runScript(manager, 'typecheck');
		console.log('\n✅ Project checks passed.');
	} catch (error) {
		console.error(`\n❌ Project checks failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
