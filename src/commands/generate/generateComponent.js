import prompts from 'prompts';
import path from 'path';
import { selectContext } from '../../utils/contextUtils.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const componentTemplate = `<script lang="ts">
\timport './style.scss';
</script>

{{componentName}}
`;

const styleTemplate = `// Add your styles here
`;

export default async function generateComponent() {
    const context = await selectContext('Select context for component:');

    const { componentPath } = await prompts({
        type: 'text',
        name: 'componentPath',
        message: 'Component path (e.g. reviews/modals/ReviewModal):',
        validate: value => value.length > 0 ? true : 'Path cannot be empty'
    });

    // Parse the path
    const normalizedPath = componentPath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/');
    const componentName = pathParts[pathParts.length - 1];

    // Build the full path: src/app/{context}/ui/components/{path}
    const contextUiPath = path.join(process.cwd(), 'src/app', context, 'ui/components');
    const fullComponentPath = path.join(contextUiPath, normalizedPath);

    console.log(`\n🚀 Generating component: ${componentName}...\n`);

    // Create Component.svelte
    await writeIfNotExists(
        path.join(fullComponentPath, 'Component.svelte'),
        componentTemplate.replace(/{{componentName}}/g, componentName)
    );

    // Create style.scss
    await writeIfNotExists(
        path.join(fullComponentPath, 'style.scss'),
        styleTemplate
    );

    console.log(`✅ Component created at: ${fullComponentPath}`);
    console.log(`\n💡 Files created:`);
    console.log(`   - Component.svelte`);
    console.log(`   - style.scss`);
}
