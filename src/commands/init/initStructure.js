import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../../utils/loadConfig.js';

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

async function createIndexFile(dirPath, exportPatterns = []) {
    const indexPath = path.join(dirPath, 'index.ts');
    if (exportPatterns.length > 0) {
        const content = exportPatterns.map(pattern => `export * from '${pattern}';`).join('\n') + '\n';
        await fs.writeFile(indexPath, content, 'utf-8');
    }
}

async function createBaseStructure(root) {
    // Domain
    const domainPath = path.join(root, 'Domain');
    await createDirIfNotExists(path.join(domainPath, 'Entities'));
    await createDirIfNotExists(path.join(domainPath, 'Ports'));

    // Infrastructure
    const infraPath = path.join(root, 'Infrastructure');
    await createDirIfNotExists(path.join(infraPath, 'Http', 'Repositories'));
    await createDirIfNotExists(path.join(infraPath, 'Http', 'Datasource'));
    await createDirIfNotExists(path.join(infraPath, 'Providers'));

    // Application
    const appPath = path.join(root, 'Application');
    await createDirIfNotExists(path.join(appPath, 'Services'));
    await createDirIfNotExists(path.join(appPath, 'Providers'));

    // Delivery - organized by modules, not by type
    const deliveryPath = path.join(root, 'Delivery');
    await createDirIfNotExists(deliveryPath);
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
    await createDirIfNotExists(path.join(CORE_PATH, 'Datasource'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Response'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Schema'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Middleware'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Presenter'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Translation'));

    // Create core index.ts that exports all subdirectories
    await createIndexFile(CORE_PATH, [
        './Schema',
        './Datasource',
        './Response',
        './Middleware',
        './Translation'
    ]);

    console.log('✅ Structure initialization complete!');
}