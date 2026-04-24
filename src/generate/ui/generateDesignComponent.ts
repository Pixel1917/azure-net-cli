import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toPascalCase } from '../../utils/contextUtils.js';
import { normalizeContexts } from '../../init/initAliases.js';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const createComponentContent = (propsName: string): string => `<script lang="ts">
import type { ${propsName} } from './types';
const {}: ${propsName} = $props();
</script>
<!--Your HTML here-->
<style lang="scss">
\t@use './style';
</style>
`;

const createTypesContent = (propsName: string): string => `export interface ${propsName} {}
`;

const createIndexContent = (name: string): string => `export { default as ${name} } from './Component.svelte';
`;

const printContextsError = (): void => {
	console.error('❌ Cannot generate UI artifact: `contexts` is missing or empty in azure-net.config.ts/js');
};

const selectContext = async (): Promise<string | null> => {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);
	if (!contexts.length) return null;

	const { context } = await prompts({
		type: 'select',
		name: 'context',
		message: 'Select context:',
		choices: contexts.map((item) => ({ title: item.name, value: item.name })),
		initial: 0
	});

	return context ? String(context) : null;
};

export default async function generateDesignComponent(): Promise<void> {
	const context = await selectContext();
	if (!context) {
		printContextsError();
		process.exitCode = 1;
		return;
	}

	const { rawName } = await prompts({
		type: 'text',
		name: 'rawName',
		message: 'Design component name:',
		validate: (value: string) => (String(value).trim().length > 0 ? true : 'Name is required')
	});

	const name = toPascalCase(String(rawName ?? 'DesignComponent')) || 'DesignComponent';
	const propsName = `IDesignComponent${name}Props`;
	const targetDir = path.join(process.cwd(), 'src', 'app', context, 'ui', 'design', name);

	await fs.mkdir(targetDir, { recursive: true });
	await writeIfNotExists(path.join(targetDir, 'Component.svelte'), createComponentContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'style.scss'), '');
	await writeIfNotExists(path.join(targetDir, 'types.ts'), createTypesContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'index.ts'), createIndexContent(name));

	console.log(`✅ Design component generated: ${targetDir}`);
}
