import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toPascalCase } from '../../utils/contextUtils.js';
import { selectWorkspace } from '../../utils/architecture.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

type ComponentKind = 'shared' | 'layout' | 'page';

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

export default async function generateComponent(): Promise<void> {
	const workspace = await selectWorkspace();
	if (!workspace) return;

	const { rawName } = await prompts({
		type: 'text',
		name: 'rawName',
		message: 'Component name:',
		validate: (value: string) => (String(value).trim().length > 0 ? true : 'Name is required')
	});

	const { componentKind } = await prompts({
		type: 'select',
		name: 'componentKind',
		message: 'Component kind:',
		choices: [
			{ title: 'shared', value: 'shared' },
			{ title: 'layout', value: 'layout' },
			{ title: 'page', value: 'page' }
		],
		initial: 0
	});

	const name = toPascalCase(String(rawName ?? 'Component')) || 'Component';
	const propsName = `IComponent${name}Props`;
	const kind = (componentKind as ComponentKind) ?? 'shared';
	let targetDir = path.join(workspace.path, 'Ui', 'Components', toPascalCase(kind));

	if (kind === 'page') {
		const { pageFolderRaw } = await prompts({
			type: 'text',
			name: 'pageFolderRaw',
			message: 'Page folder name:',
			validate: (value: string) => (String(value).trim().length > 0 ? true : 'Page folder name is required')
		});

		const pageFolder = toPascalCase(String(pageFolderRaw ?? 'Page')) || 'Page';
		targetDir = path.join(targetDir, pageFolder);
	}

	targetDir = path.join(targetDir, name);

	await fs.mkdir(targetDir, { recursive: true });
	await writeIfNotExists(path.join(targetDir, 'Component.svelte'), createComponentContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'Style.scss'), '');
	await writeIfNotExists(path.join(targetDir, 'Types.ts'), createTypesContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'index.ts'), createIndexContent(name));

	console.log(`✅ Component generated: ${targetDir}`);
}
