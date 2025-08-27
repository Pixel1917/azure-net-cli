import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { updateCoreIndex } from '../../utils/fileUtils.js';

const APP_ROOT = path.join(process.cwd(), 'src', 'app');
const CONTEXTS_PATH = path.join(APP_ROOT, 'contexts');
const SHARED_PATH = path.join(APP_ROOT, 'shared');
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

async function createBaseStructure(root, contextName, contextAlias) {
    // Domain - новая структура
    const domainPath = path.join(root, 'Domain');
    await createDirIfNotExists(domainPath);

    // Infrastructure
    const infraPath = path.join(root, 'Infrastructure');
    await createDirIfNotExists(path.join(infraPath, 'Http', 'Repositories'));
    await createDirIfNotExists(path.join(infraPath, 'Http', 'Datasource'));
    await createDirIfNotExists(path.join(infraPath, 'Providers'));

    // Create empty InfrastructureProvider
    const infraProviderContent = `import { createBoundaryProvider } from '@azure-net/kit';

export const InfrastructureProvider = createBoundaryProvider(
\t'${contextName}InfrastructureProvider',
\t() => ({
\t\t// Infrastructure services will be added here manually
\t})
);`;

    await fs.writeFile(
        path.join(infraPath, 'Providers', 'InfrastructureProvider.ts'),
        infraProviderContent,
        'utf-8'
    );

    await fs.writeFile(
        path.join(infraPath, 'Providers', 'index.ts'),
        `export * from './InfrastructureProvider';`,
        'utf-8'
    );

    // Create Infrastructure index
    await fs.writeFile(
        path.join(infraPath, 'index.ts'),
        `export * from './Providers';`,
        'utf-8'
    );

    // Application
    const appPath = path.join(root, 'Application');
    await createDirIfNotExists(path.join(appPath, 'Services'));
    await createDirIfNotExists(path.join(appPath, 'Providers'));

    // Create empty ApplicationProvider with correct import
    const appProviderContent = `import { createBoundaryProvider } from '@azure-net/kit';
import { InfrastructureProvider } from '\$${contextAlias}/Infrastructure';

export const ApplicationProvider = createBoundaryProvider(
\t'${contextName}ApplicationProvider',
\t({ InfrastructureProvider }) => ({
\t\t// Application services will be added here manually
\t}),
\t{ dependsOn: { InfrastructureProvider } }
);`;

    await fs.writeFile(
        path.join(appPath, 'Providers', 'ApplicationProvider.ts'),
        appProviderContent,
        'utf-8'
    );

    await fs.writeFile(
        path.join(appPath, 'Providers', 'index.ts'),
        `export * from './ApplicationProvider';`,
        'utf-8'
    );

    // Create Application index
    await fs.writeFile(
        path.join(appPath, 'index.ts'),
        `export * from './Providers';`,
        'utf-8'
    );

    // Delivery - organized by modules
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
        const contextName = context.charAt(0).toUpperCase() + context.slice(1);
        await createBaseStructure(contextPath, contextName, context);
    }

    // Create empty shared folder
    await createDirIfNotExists(SHARED_PATH);

    // Create core structure with all functionality
    await createDirIfNotExists(CORE_PATH);
    await createDirIfNotExists(path.join(CORE_PATH, 'Datasource'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Response'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Schema'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Middleware'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Presenter'));
    await createDirIfNotExists(path.join(CORE_PATH, 'Translation'));

    // Update core index
    await updateCoreIndex();

    console.log('✅ Structure initialization complete!');
}