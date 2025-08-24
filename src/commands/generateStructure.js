import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../utils/loadConfig.js';

const BASE_STRUCTURE = ['Domain', 'Infra', 'Application', 'Presentation'];
const APP_ROOT = path.join(process.cwd(), 'src', 'app');
const CONTEXTS_PATH = path.join(APP_ROOT, 'contexts');
const CORE_PATH = path.join(APP_ROOT, 'core');

async function createDirIfNotExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        console.log(`📁 Created: ${dirPath}`);
    } catch (e) {
        console.error(`❌ Failed to create ${dirPath}:`, e.message);
    }
}

async function createBaseStructure(root) {
    for (const section of BASE_STRUCTURE) {
        const sectionPath = path.join(root, section);
        await createDirIfNotExists(sectionPath);

        if (section === 'Infra') {
            await createDirIfNotExists(path.join(sectionPath, 'Repo'));
        }
        if (section === 'Application') {
            await createDirIfNotExists(path.join(sectionPath, 'Services'));
            await createDirIfNotExists(path.join(sectionPath, 'Orchestrators'));
        }
    }
}

export default async function initStructure() {
    const config = await loadUserConfig();
    const modules = config.modules;
    const hasModules = Array.isArray(modules) && modules.length > 0;

    console.log('📦 Generating architecture in: /contexts');

    // всегда shared-context
    const sharedKernelPath = path.join(CONTEXTS_PATH, 'shared-context');
    await createBaseStructure(sharedKernelPath);

    if (hasModules) {
        // по модулям
        console.log('🔧 Creating module contexts...');
        for (const mod of modules) {
            const modPath = path.join(CONTEXTS_PATH, mod);
            await createBaseStructure(modPath);
        }
    } else {
        // fallback-контекст
        console.log('🧱 No modules found — using default "app-context"...');
        const fallbackPath = path.join(CONTEXTS_PATH, 'app-context');
        await createBaseStructure(fallbackPath);
    }

    // Доп. слои вне contexts
    await createDirIfNotExists(CORE_PATH);
    await createDirIfNotExists(path.join(CORE_PATH, 'datasources'));
    await createDirIfNotExists(path.join(APP_ROOT, 'ui'));

    console.log('✅ Structure initialization complete!');
}