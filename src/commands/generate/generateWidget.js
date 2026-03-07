import prompts from 'prompts';
import path from 'path';
import { selectContext } from '../../utils/contextUtils.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const widgetTemplate = `<script lang="ts">
\timport './style.scss';
</script>

{{widgetName}}
`;

const styleTemplate = `// Add your styles here
`;

export default async function generateWidget() {
    const context = await selectContext('Select context for widget:');

    const { widgetPath } = await prompts({
        type: 'text',
        name: 'widgetPath',
        message: 'Widget path (e.g. modals/ConfirmModal):',
        validate: value => value.length > 0 ? true : 'Path cannot be empty'
    });

    // Parse the path
    const normalizedPath = widgetPath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/');
    const widgetName = pathParts[pathParts.length - 1];

    // Build the full path: src/app/{context}/ui/widgets/{path}
    const contextUiPath = path.join(process.cwd(), 'src/app', context, 'ui/widgets');
    const fullWidgetPath = path.join(contextUiPath, normalizedPath);

    console.log(`\n🚀 Generating widget: ${widgetName}...\n`);

    // Create Component.svelte
    await writeIfNotExists(
        path.join(fullWidgetPath, 'Component.svelte'),
        widgetTemplate.replace(/{{widgetName}}/g, widgetName)
    );

    // Create style.scss
    await writeIfNotExists(
        path.join(fullWidgetPath, 'style.scss'),
        styleTemplate
    );

    console.log(`✅ Widget created at: ${fullWidgetPath}`);
    console.log(`\n💡 Files created:`);
    console.log(`   - Component.svelte`);
    console.log(`   - style.scss`);
}
