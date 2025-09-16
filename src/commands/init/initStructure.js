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
    const domainPath = path.join(root, 'domain');
    await createDirIfNotExists(domainPath);

    // Infrastructure
    const infraPath = path.join(root, 'infrastructure');
    await createDirIfNotExists(path.join(infraPath, 'http', 'repositories'));
    await createDirIfNotExists(path.join(infraPath, 'http', 'datasources'));
    await createDirIfNotExists(path.join(infraPath, 'providers'));

    // Create empty InfrastructureProvider
    const infraProviderContent = `import { createBoundaryProvider } from '@azure-net/kit';

export const InfrastructureProvider = createBoundaryProvider(
\t'${contextName}InfrastructureProvider', {register: () => ({})}
);`;

    await fs.writeFile(
        path.join(infraPath, 'providers', 'InfrastructureProvider.ts'),
        infraProviderContent,
        'utf-8'
    );

    await fs.writeFile(
        path.join(infraPath, 'providers', 'index.ts'),
        `export * from './InfrastructureProvider';`,
        'utf-8'
    );

    // Create Infrastructure index
    await fs.writeFile(
        path.join(infraPath, 'index.ts'),
        `export * from './providers';`,
        'utf-8'
    );

    // Application
    const appPath = path.join(root, 'application');
    await createDirIfNotExists(path.join(appPath, 'services'));
    await createDirIfNotExists(path.join(appPath, 'providers'));

    // Create empty ApplicationProvider with correct import
    const appProviderContent = `import { createBoundaryProvider } from '@azure-net/kit';
import { InfrastructureProvider } from '\$${contextAlias}/infrastructure';

export const ApplicationProvider = createBoundaryProvider(
\t'${contextName}ApplicationProvider',
\t{
\t\tdependsOn: { InfrastructureProvider },
\t\tregister: ({ InfrastructureProvider }) => ({
\t\t// Application services will be added here manually
\t\t}),
\t}
);`;

    await fs.writeFile(
        path.join(appPath, 'providers', 'ApplicationProvider.ts'),
        appProviderContent,
        'utf-8'
    );

    await fs.writeFile(
        path.join(appPath, 'providers', 'index.ts'),
        `export * from './ApplicationProvider';`,
        'utf-8'
    );

    // Create Application index
    await fs.writeFile(
        path.join(appPath, 'index.ts'),
        `export * from './providers';`,
        'utf-8'
    );

    // Delivery - organized by modules
    const deliveryPath = path.join(root, 'delivery');
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
    await createDirIfNotExists(path.join(CORE_PATH, 'datasources'));
    await createDirIfNotExists(path.join(CORE_PATH, 'responses'));
    await createDirIfNotExists(path.join(CORE_PATH, 'schemas'));
    await createDirIfNotExists(path.join(CORE_PATH, 'middleware'));
    await createDirIfNotExists(path.join(CORE_PATH, 'presenters'));
    await createDirIfNotExists(path.join(CORE_PATH, 'translations'));

    // Update core index
    await updateCoreIndex();

    console.log('✅ Structure initialization complete!');
}