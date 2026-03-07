import prompts from 'prompts';
import path from 'path';
import { selectContext } from '../../utils/contextUtils.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const designComponentTemplate = `<script lang="ts">
\timport './style.scss';
</script>

{{componentName}}
`;

const styleTemplate = `// Add your styles here
`;

export default async function generateDesignComponent() {
    const context = await selectContext('Select context for design component:');

    const { componentPath } = await prompts({
        type: 'text',
        name: 'componentPath',
        message: 'Design component path (e.g. Button/Themes/PrimaryButton):',
        validate: value => value.length > 0 ? true : 'Path cannot be empty'
    });

    // Parse the path
    const normalizedPath = componentPath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/');
    const componentName = pathParts[pathParts.length - 1];

    // Build the full path: src/app/{context}/ui/design/{path}
    const contextUiPath = path.join(process.cwd(), 'src/app', context, 'ui/design');
    const fullComponentPath = path.join(contextUiPath, normalizedPath);

    console.log(`\n🚀 Generating design component: ${componentName}...\n`);

    // Create Component.svelte
    await writeIfNotExists(
        path.join(fullComponentPath, 'Component.svelte'),
        designComponentTemplate.replace(/{{componentName}}/g, componentName)
    );

    // Create style.scss
    await writeIfNotExists(
        path.join(fullComponentPath, 'style.scss'),
        styleTemplate
    );

    console.log(`✅ Design component created at: ${fullComponentPath}`);
    console.log(`\n💡 Files created:`);
    console.log(`   - Component.svelte`);
    console.log(`   - style.scss`);
}
