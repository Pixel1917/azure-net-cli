import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../../utils/loadConfig.js';

const BASE_STRUCTURE = ['Domain', 'Infrastructure', 'Application', 'Delivery'];
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

        if (section === 'Infrastructure') {
            await createDirIfNotExists(path.join(sectionPath, 'Repositories'));
            await createDirIfNotExists(path.join(sectionPath, 'Datasources'));
            await createDirIfNotExists(path.join(sectionPath, 'DTO'));
            await createDirIfNotExists(path.join(sectionPath, 'Providers'));
        }
        if (section === 'Application') {
            await createDirIfNotExists(path.join(sectionPath, 'Services'));
            await createDirIfNotExists(path.join(sectionPath, 'Providers'));
        }
        if (section === 'Domain') {
            await createDirIfNotExists(path.join(sectionPath, 'Entities'));
            await createDirIfNotExists(path.join(sectionPath, 'Ports'));
        }
        if (section === 'Delivery') {
            await createDirIfNotExists(path.join(sectionPath, 'Presenters'));
            await createDirIfNotExists(path.join(sectionPath, 'Schemas'));
            await createDirIfNotExists(path.join(sectionPath, 'Actions'));
            await createDirIfNotExists(path.join(sectionPath, 'Stores'));
        }
    }
}

export default async function initStructure() {
    const config = await loadUserConfig();
    const contexts = config.contexts || ['app'];

    console.log('📦 Generating architecture...');

    // Create contexts
    for (const context of contexts) {
        const contextPath = path.join(CONTEXTS_PATH, context);
        await createBaseStructure(contextPath);
    }

    // Create core structure
    await createDirIfNotExists(CORE_PATH);
    await createDirIfNotExists(path.join(CORE_PATH, 'Datasources'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Responses'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Schemas'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Middleware'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Presenters'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Translations'));

    console.log('✅ Structure initialization complete!');
}