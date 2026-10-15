import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeConfigDefaults, loadUserConfig } from '../utils/loadConfig.js';
import { discoverContexts, discoverPresentationWorkspaces, ensureContextStructure, ensurePresentationStructure, getPlatformPath, getPresentationPath, normalizePascalName, SHARED_CONTEXT, SHARED_WORKSPACE } from '../utils/architecture.js';
import { writeIfNotExists } from '../utils/fileUtils.js';
import initAliases from './initAliases.js';
export default async function initStructure() {
    await initializeConfigDefaults();
    const config = await loadUserConfig();
    for (const name of new Set([SHARED_CONTEXT, ...(await discoverContexts())]))
        await ensureContextStructure(name);
    let initial = false;
    try {
        initial = (await fs.readdir(getPresentationPath())).length === 0;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        initial = true;
    }
    const workspaces = initial ? (config.presentationWorkspaces ?? []).map(normalizePascalName) : await discoverPresentationWorkspaces();
    if (workspaces.length) {
        for (const workspace of new Set([...workspaces, SHARED_WORKSPACE]))
            await ensurePresentationStructure(workspace);
    }
    else
        await ensurePresentationStructure();
    const platform = getPlatformPath();
    for (const dir of ['Foundation/Datasource', 'Foundation/Response', 'Foundation/Schema/CustomRules', 'Foundation/DI', 'Bootstrap'])
        await fs.mkdir(path.join(platform, dir), { recursive: true });
    await writeIfNotExists(path.join(platform, 'Foundation/DI/ApplicationProvider.ts'), `import { CreateDiContainer } from '@azure-net/kit';\n\nexport const ApplicationProvider = CreateDiContainer('ApplicationProvider', {\n\tregister: () => ({})\n});\n`);
    await writeIfNotExists(path.join(platform, 'Foundation/DI/index.ts'), "export * from './ApplicationProvider';\n");
    await initAliases();
    console.log('Folders structure initialized');
}
