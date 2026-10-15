import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toPascalCase } from '../../utils/contextUtils.js';
import { selectWorkspace } from '../../utils/architecture.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';
const createComponentContent = (propsName) => `<script lang="ts">
import type { ${propsName} } from './Types';
const {}: ${propsName} = $props();
</script>
<!--Your HTML here-->
<style lang="scss">
\t@use './Style';
</style>
`;
const createTypesContent = (propsName) => `export interface ${propsName} {}
`;
const createIndexContent = (name) => `export { default as ${name} } from './Component.svelte';
`;
export default async function generateWidget() {
    const workspace = await selectWorkspace();
    if (!workspace)
        return;
    const { rawName } = await prompts({
        type: 'text',
        name: 'rawName',
        message: 'Widget name:',
        validate: (value) => (String(value).trim().length > 0 ? true : 'Name is required')
    });
    const name = toPascalCase(String(rawName ?? 'Widget')) || 'Widget';
    const propsName = `IWidget${name}Props`;
    const targetDir = path.join(workspace.path, 'Ui', 'Widgets', name);
    await fs.mkdir(targetDir, { recursive: true });
    await writeIfNotExists(path.join(targetDir, 'Component.svelte'), createComponentContent(propsName));
    await writeIfNotExists(path.join(targetDir, 'Style.scss'), '');
    await writeIfNotExists(path.join(targetDir, 'Types.ts'), createTypesContent(propsName));
    await writeIfNotExists(path.join(targetDir, 'index.ts'), createIndexContent(name));
    console.log(`✅ Widget generated: ${targetDir}`);
}
