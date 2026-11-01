import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';
import checkInternal from './checkInternal.js';
const isPackageManager = (value) => typeof value === 'string' && ['pnpm', 'npm', 'yarn', 'bun'].includes(value);
const runScript = (manager, script) => {
    const command = `${manager} run ${script}`;
    console.log(`\n▶ Running: ${command}`);
    execSync(command, { stdio: 'inherit' });
};
const runInternalChecks = async () => {
    console.log('\n▶ Running: azure-net check internal');
    process.exitCode = 0;
    await checkInternal();
    if ((process.exitCode ?? 0) !== 0) {
        throw new Error('azure-net check internal failed');
    }
};
export default async function checkProject() {
    const config = await loadUserConfig();
    const manager = config.packageManager;
    if (!isPackageManager(manager)) {
        console.error('❌ packageManager is missing or invalid in azure-net.config.ts/js. Use one of: bun, pnpm, npm, yarn');
        process.exitCode = 1;
        return;
    }
    try {
        const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
        // Pre-commit must not implicitly run the commonly mutating `format` script.
        // Projects opting into format:check must keep that script read-only, like lint/check.
        if (typeof pkg.scripts?.['format:check'] === 'string' && pkg.scripts['format:check'].trim())
            runScript(manager, 'format:check');
        else
            console.log('Skipping formatting: no format:check script. Add a read-only format:check script (for example, prettier --check .).');
        await runInternalChecks();
        runScript(manager, 'lint');
        runScript(manager, 'check');
        console.log('\n✅ Project checks passed.');
    }
    catch (error) {
        console.error(`\n❌ Project checks failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
