import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateDefaultFactoryConfig } from '../scaffolds/updateDefaultFactoryConfig.js';
import { loadUserConfig } from '../utils/loadConfig.js';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const marker = '# azure-net managed pre-commit v1';
async function exists(file) {
    try {
        await fs.lstat(file);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function hookPaths() {
    const cwd = process.cwd();
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const root = path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8' }).trim());
    return {
        hook: path.join(root, 'pre-commit'),
        backup: path.join(root, 'pre-commit.azure-net-original'),
        state: path.join(root, 'pre-commit.azure-net.json')
    };
}
function wrapper(cwd, backup, executable) {
    return `#!/bin/sh
${marker}
(cd ${quote(cwd)} && PATH=${quote(path.join(cwd, 'node_modules/.bin'))}:"$PATH" azure-net check project) </dev/null || exit $?
${executable ? `exec ${quote(backup)} "$@"` : 'exit 0'}
`;
}
async function configUpdate() {
    const cwd = process.cwd();
    await loadUserConfig(cwd);
    const ts = path.join(cwd, 'azure-net.config.ts');
    const js = path.join(cwd, 'azure-net.config.js');
    const file = (await exists(ts)) ? ts : (await exists(js)) ? js : ts;
    const original = (await exists(file)) ? await fs.readFile(file, 'utf8') : '';
    return { file, content: updateDefaultFactoryConfig(original, 'runChecksBeforePush', false) };
}
export async function addGitHooks() {
    const { hook, backup, state } = hookPaths();
    const config = await configUpdate();
    if (await exists(state)) {
        const saved = JSON.parse(await fs.readFile(state, 'utf8'));
        if (!(await exists(hook)) || (await fs.readFile(hook, 'utf8')) !== saved.content)
            throw new Error('Managed pre-commit was modified. Preserve or restore it before adding hooks.');
        await fs.writeFile(config.file, config.content);
        return;
    }
    if (await exists(backup))
        throw new Error(`Existing backup preserved: ${backup}. Resolve it before installing hooks.`);
    const hadOriginal = await exists(hook);
    const info = hadOriginal ? await fs.lstat(hook) : undefined;
    if (info && !info.isFile())
        throw new Error('Existing pre-commit is not a regular file; refusing to replace it.');
    const content = wrapper(process.cwd(), backup, Boolean(info && info.mode & 0o111));
    await fs.mkdir(path.dirname(hook), { recursive: true });
    if (hadOriginal)
        await fs.rename(hook, backup);
    try {
        await fs.writeFile(hook, content, { flag: 'wx', mode: 0o755 });
        await fs.writeFile(state, JSON.stringify({ content, hadOriginal }), { flag: 'wx' });
        await fs.writeFile(config.file, config.content);
    }
    catch (error) {
        if ((await exists(hook)) && (await fs.readFile(hook, 'utf8')) === content)
            await fs.unlink(hook);
        if (hadOriginal && !(await exists(hook)))
            await fs.rename(backup, hook);
        await fs.rm(state, { force: true });
        throw error;
    }
    console.log('Installed pre-commit: azure-net check project. Existing hook preserved; runChecksBeforePush set to false. No packages installed.');
}
export async function removeGitHooks() {
    const { hook, backup, state } = hookPaths();
    if (!(await exists(state))) {
        console.log('No managed git hooks to remove.');
        return;
    }
    const saved = JSON.parse(await fs.readFile(state, 'utf8'));
    if (!(await exists(hook)) || (await fs.readFile(hook, 'utf8')) !== saved.content || !saved.content.includes(marker)) {
        throw new Error('Managed pre-commit was modified. Refusing to remove user changes.');
    }
    if (saved.hadOriginal && !(await exists(backup)))
        throw new Error('Original pre-commit backup is missing. Nothing removed.');
    await fs.unlink(hook);
    if (saved.hadOriginal)
        await fs.rename(backup, hook);
    await fs.unlink(state);
    console.log('Removed managed pre-commit; original hook restored. Review runChecksBeforePush in azure-net.config if push checks should run through the CLI again.');
}
