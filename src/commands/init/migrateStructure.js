import fs from 'fs/promises';
import path from 'path';
import { loadUserConfig } from '../../utils/loadConfig.js';

const APP_PATH = path.join(process.cwd(), 'src/app');
const OLD_CONTEXTS_PATH = path.join(APP_PATH, 'contexts');
const OLD_CORE_PATH = path.join(APP_PATH, 'core');
const NEW_CORE_PATH = path.join(process.cwd(), 'src/core');

async function directoryExists(dirPath) {
    try {
        const stat = await fs.stat(dirPath);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

async function moveDirectory(source, destination) {
    try {
        // Check if source exists
        if (!(await directoryExists(source))) {
            return false;
        }

        // Create destination parent directory if needed
        await fs.mkdir(path.dirname(destination), { recursive: true });

        // Move the directory
        await fs.rename(source, destination);
        console.log(`✅ Moved: ${source} -> ${destination}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to move ${source}:`, error.message);
        return false;
    }
}

async function removeEmptyDir(dirPath) {
    try {
        await fs.rmdir(dirPath);
        console.log(`🗑️  Removed empty directory: ${dirPath}`);
    } catch {
        // Directory not empty or doesn't exist
    }
}

export default async function migrateStructure() {
    const config = await loadUserConfig();
    const contexts = config.contexts || ['app'];

    console.log('🔄 Starting structure migration...\n');
    console.log('This will reorganize existing structure to the new format:\n');
    console.log('  - src/app/contexts/{context} -> src/app/{context}');
    console.log('  - src/app/core -> src/core');
    console.log('  - Ensure layers and ui folders exist\n');

    // Step 1: Migrate core from src/app/core to src/core
    if (await directoryExists(OLD_CORE_PATH)) {
        console.log('📦 Migrating core...');

        // Check if new core already exists
        if (await directoryExists(NEW_CORE_PATH)) {
            console.log('⚠️  Core already exists at src/core, skipping core migration...');
        } else {
            await moveDirectory(OLD_CORE_PATH, NEW_CORE_PATH);
        }
    }

    // Step 2: Migrate contexts
    for (const context of contexts) {
        console.log(`\n📁 Migrating context: ${context}`);

        const oldContextPath = path.join(OLD_CONTEXTS_PATH, context);
        const newContextPath = path.join(APP_PATH, context);

        // Check if context exists in old location (src/app/contexts/{context})
        if (await directoryExists(oldContextPath)) {
            // Check if new location already exists
            if (await directoryExists(newContextPath)) {
                console.log(`⚠️  Context '${context}' already exists at src/app/${context}, skipping...`);
                continue;
            }

            // Move from contexts/{context} to app/{context}
            await moveDirectory(oldContextPath, newContextPath);
        }

        // Now ensure the context has layers and ui structure
        const contextPath = newContextPath;

        if (!(await directoryExists(contextPath))) {
            console.log(`⚠️  Context '${context}' does not exist, skipping...`);
            continue;
        }

        const layersPath = path.join(contextPath, 'layers');
        const uiPath = path.join(contextPath, 'ui');

        // Check if already has layers structure
        if (await directoryExists(layersPath)) {
            console.log(`✓ Context '${context}' already has layers structure`);

            // Just ensure ui folder exists
            if (!(await directoryExists(uiPath))) {
                await fs.mkdir(uiPath, { recursive: true });
                console.log(`✅ Created: ${uiPath}`);
            }

            continue;
        }

        // Need to create layers structure
        console.log(`📦 Creating layers structure for '${context}'...`);

        await fs.mkdir(layersPath, { recursive: true });
        await fs.mkdir(uiPath, { recursive: true });
        console.log(`✅ Created: ${layersPath}`);
        console.log(`✅ Created: ${uiPath}`);

        // Move existing layer folders to layers directory
        const layerFolders = ['domain', 'infrastructure', 'application', 'delivery'];

        for (const layer of layerFolders) {
            const sourcePath = path.join(contextPath, layer);
            const destPath = path.join(layersPath, layer);

            await moveDirectory(sourcePath, destPath);
        }

        console.log(`✅ Context '${context}' migration completed!`);
    }

    // Step 3: Clean up old contexts folder if empty
    if (await directoryExists(OLD_CONTEXTS_PATH)) {
        await removeEmptyDir(OLD_CONTEXTS_PATH);
    }

    console.log('\n✅ Structure migration complete!');
    console.log('\n💡 Next steps:');
    console.log('   1. Run "azure-net init:aliases" to update path aliases');
    console.log('   2. Verify all imports are working correctly');
    console.log('   3. Update any hardcoded paths in your code');
}
