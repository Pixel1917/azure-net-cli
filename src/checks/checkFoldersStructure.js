import fs from 'node:fs/promises';
import path from 'node:path';
import { appRoot, directories, report } from './architecture.js';
export default async function checkFoldersStructure() {
    const issues = [];
    const issue = (file, message) => {
        issues.push({ file, line: 1, message });
    };
    const exists = async (root) => (await fs.stat(root).catch(() => null))?.isDirectory() ?? false;
    const allowed = async (root, names) => {
        if (!(await exists(root)))
            return;
        for (const name of await directories(root))
            if (!names.includes(name))
                issue(path.join(root, name), `Allowed folders: ${names.join(', ')}`);
    };
    const required = async (root, names) => {
        for (const name of names)
            if (!(await exists(path.join(root, name))))
                issue(path.join(root, name), 'Required architecture folder is missing');
    };
    const walk = async (root) => {
        if (root === appRoot() || root.startsWith(`${appRoot()}${path.sep}`)) {
            for (const entry of await fs.readdir(root, { withFileTypes: true })) {
                if (!entry.isFile() || entry.name === 'index.ts')
                    continue;
                if (!/^[A-Z][A-Za-z0-9]*(?:\.(?:module|svelte|d))?\.[A-Za-z0-9]+$/.test(entry.name))
                    issue(path.join(root, entry.name), 'App files must use PascalCase (except index.ts; module, svelte and declaration suffixes are allowed)');
            }
        }
        for (const name of await directories(root)) {
            const file = path.join(root, name);
            if (['consts', 'utils', 'common'].includes(name.toLowerCase()))
                issue(file, 'Utility directories Consts/utils/common are prohibited throughout src');
            if (file.startsWith(`${appRoot()}${path.sep}`) && !/^[A-Z][A-Za-z0-9]*$/.test(name))
                issue(file, 'App directories must use PascalCase alphanumeric names');
            if (name.toLowerCase() === 'shared' && file !== path.join(appRoot(), 'Presentation', 'Shared'))
                issue(file, 'Shared is allowed only at src/app/Presentation/Shared');
            await walk(file);
        }
    };
    try {
        const src = path.join(process.cwd(), 'src');
        await required(src, ['app', 'platform']);
        await allowed(appRoot(), ['Contexts', 'Presentation']);
        await required(appRoot(), ['Contexts', 'Presentation']);
        for (const context of await directories(path.join(appRoot(), 'Contexts'))) {
            const root = path.join(appRoot(), 'Contexts', context);
            if (context === 'SharedKernel') {
                await allowed(root, ['Contracts', 'Domain']);
                await required(root, ['Contracts', 'Domain']);
                continue;
            }
            for (const aggregate of await directories(root)) {
                const aggregateRoot = path.join(root, aggregate);
                await allowed(aggregateRoot, ['Domain', 'Application', 'Infrastructure']);
                await required(aggregateRoot, ['Domain', 'Application', 'Infrastructure']);
            }
        }
        const presentation = path.join(appRoot(), 'Presentation');
        for (const boundary of await directories(presentation)) {
            const root = path.join(presentation, boundary);
            if (['ui', 'scopes', 'shell', 'routes'].includes(boundary.toLowerCase()))
                issue(root, 'Presentation requires an AppBoundary (including Shared)');
            if (boundary.toLowerCase() === 'shared' && boundary !== 'Shared')
                issue(root, 'Use the canonical folder name "Shared"');
            await allowed(root, ['Scopes', 'Shell', 'Ui']);
            await allowed(path.join(root, 'Ui'), ['Actions', 'Components', 'Style']);
            await allowed(path.join(root, 'Ui', 'Components'), ['Scopes', 'Composite', 'Page', 'Core']);
        }
        await walk(src);
    }
    catch (error) {
        issue(appRoot(), String(error));
    }
    report('Folders structure', issues);
}
