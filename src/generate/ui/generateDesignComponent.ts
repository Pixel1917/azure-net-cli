import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toPascalCase } from '../../utils/contextUtils.js';
import { selectWorkspace } from '../../utils/architecture.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const createComponentContent = (propsName: string): string => `<script lang="ts">
import type { ${propsName} } from './Types';
const {}: ${propsName} = $props();
</script>
<!--Your HTML here-->
<style lang="scss">
\t@use './Style';
</style>
`;

const createTypesContent = (propsName: string): string => `export interface ${propsName} {}
`;

const createIndexContent = (name: string): string => `export { default as ${name} } from './Component.svelte';
`;

export default async function generateDesignComponent(): Promise<void> {
	const workspace = await selectWorkspace();
	if (!workspace) return;

	const { rawName } = await prompts({
		type: 'text',
		name: 'rawName',
		message: 'Design component name:',
		validate: (value: string) => (String(value).trim().length > 0 ? true : 'Name is required')
	});

	const name = toPascalCase(String(rawName ?? 'DesignComponent')) || 'DesignComponent';
	const propsName = `IDesignComponent${name}Props`;
	const targetDir = path.join(workspace.path, 'Ui', 'Design', name);

	await fs.mkdir(targetDir, { recursive: true });
	await writeIfNotExists(path.join(targetDir, 'Component.svelte'), createComponentContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'Style.scss'), '');
	await writeIfNotExists(path.join(targetDir, 'Types.ts'), createTypesContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'index.ts'), createIndexContent(name));

	console.log(`✅ Design component generated: ${targetDir}`);
}
