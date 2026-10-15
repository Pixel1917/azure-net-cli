import fs from 'node:fs/promises';
import path from 'node:path';
import { appRoot, directories, report } from './architecture.js';
export default async function checkFoldersStructure() {
    const issues = [];
    const issue = (file, message) => {
        issues.push({ file, line: 1, message });
    };
    const allowed = async (root, names) => {
        for (const name of await directories(root))
            if (!names.includes(name))
                issue(path.join(root, name), `Allowed folders: ${names.join(', ')}`);
    };
    const walk = async (root) => {
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
            if (entry.name === '.backup' && root === appRoot())
                continue;
            const file = path.join(root, entry.name);
            const routes = file === path.join(appRoot(), 'Presentation', 'routes');
            const name = entry.isDirectory() ? entry.name : entry.name.split('.')[0];
            if (!routes && !(entry.isFile() && entry.name === 'index.ts') && !/^[A-Z][A-Za-z0-9]*$/.test(name))
                issue(file, 'Folders and files under src/app must use PascalCase (except index.ts)');
            if (entry.isDirectory())
                await walk(file);
        }
    };
    try {
        await allowed(appRoot(), ['Contexts', 'Presentation', 'Platform']);
        for (const root of ['Contexts', 'Presentation', 'Platform']) {
            if (!(await fs.stat(path.join(appRoot(), root)).catch(() => null))?.isDirectory())
                issue(path.join(appRoot(), root), 'Required application root is missing');
        }
        for (const context of await directories(path.join(appRoot(), 'Contexts'))) {
            const root = path.join(appRoot(), 'Contexts', context);
            await allowed(root, ['Domain', 'Application', 'Infrastructure']);
            for (const [layer, children] of Object.entries({
                Domain: ['Entities', 'Ports', 'Enums'],
                Application: ['UseCases'],
                Infrastructure: ['Repositories']
            })) {
                const layerRoot = path.join(root, layer);
                if (!(await fs.stat(layerRoot).catch(() => null))?.isDirectory()) {
                    issue(layerRoot, 'Required context layer is missing');
                    continue;
                }
                await allowed(layerRoot, children);
            }
        }
        const presentation = path.join(appRoot(), 'Presentation');
        const folders = await directories(presentation);
        const flat = ['Ui', 'Scopes', 'Shell'];
        for (const folder of folders) {
            const canonical = [...flat, 'Shared'].find((name) => name.toLowerCase() === folder.toLowerCase());
            if (canonical && canonical !== folder)
                issue(path.join(presentation, folder), `Use the canonical folder name "${canonical}"`);
        }
        const workspaces = folders.filter((name) => ![...flat, 'routes', 'Routes'].includes(name));
        if (folders.some((name) => flat.includes(name)) && workspaces.length)
            issue(presentation, 'Presentation cannot mix flat Ui/Scopes/Shell folders with workspaces');
        for (const workspace of workspaces)
            await allowed(path.join(presentation, workspace), flat);
        await walk(appRoot());
    }
    catch (error) {
        issue(appRoot(), String(error));
    }
    report('Folders structure', issues);
}
