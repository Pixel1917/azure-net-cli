import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toPascalCase } from '../../utils/contextUtils.js';
import { normalizeContexts } from '../../init/initAliases.js';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';

const createComponentContent = (propsName) => `<script lang="ts">
import type { ${propsName} } from './types';
const {}: ${propsName} = $props();
</script>
<!--Your HTML here-->
<style lang="scss">
\t@use './style';
</style>
`;

const createTypesContent = (propsName) => `export interface ${propsName} {}
`;

const createIndexContent = (name) => `export { default as ${name} } from './Component.svelte';
`;

const printContextsError = () => {
	console.error('❌ Cannot generate UI artifact: `contexts` is missing or empty in azure-net.config.ts/js');
};

const selectContext = async () => {
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

export default async function generateWidget() {
	const context = await selectContext();
	if (!context) {
		printContextsError();
		process.exitCode = 1;
		return;
	}

	const { rawName } = await prompts({
		type: 'text',
		name: 'rawName',
		message: 'Widget name:',
		validate: (value) => (String(value).trim().length > 0 ? true : 'Name is required')
	});

	const name = toPascalCase(String(rawName ?? 'Widget')) || 'Widget';
	const propsName = `IWidget${name}Props`;
	const targetDir = path.join(process.cwd(), 'src', 'app', context, 'ui', 'widgets', name);

	await fs.mkdir(targetDir, { recursive: true });
	await writeIfNotExists(path.join(targetDir, 'Component.svelte'), createComponentContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'style.scss'), '');
	await writeIfNotExists(path.join(targetDir, 'types.ts'), createTypesContent(propsName));
	await writeIfNotExists(path.join(targetDir, 'index.ts'), createIndexContent(name));

	console.log(`✅ Widget generated: ${targetDir}`);
}
