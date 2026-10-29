import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { normalizePascalName, selectWorkspace } from '../../utils/architecture.js';

export type ComponentKind = 'core' | 'page' | 'scopes' | 'composition';
const folders: Record<ComponentKind, string> = { core: 'Core', page: 'Page', scopes: 'Scopes', composition: 'Composite' };

export function componentSegments(value: string): string[] {
	if (!value.trim()) return [];
	if (value.includes('\\') || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..'))
		throw new Error('Use a relative slash-separated component path, without . or ..');
	return value.split('/').map(normalizePascalName);
}

export async function writeComponent(root: string, componentPath: string): Promise<string> {
	const parts = componentSegments(componentPath);
	if (!parts.length) throw new Error('Component name is required');
	const name = parts.at(-1)!;
	const directory = path.join(root, ...parts);
	// Refuse to mix a new template with any existing component files.
	await fs.mkdir(path.dirname(directory), { recursive: true });
	await fs.mkdir(directory);
	const files = {
		'Component.svelte': `<script lang="ts">\n\timport type { I${name}Props } from './Types';\n\timport styles from './Style.module.scss';\n\n\tlet { children }: I${name}Props = $props();\n</script>\n\n<div class={styles.root}>\n\t{@render children?.()}\n</div>\n`,
		'Types.ts': `import type { Snippet } from 'svelte';\n\nexport interface I${name}Props {\n\tchildren?: Snippet;\n}\n`,
		'Style.module.scss': '.root {\n\tmin-width: 0;\n}\n',
		'index.ts': `export { default as ${name} } from './Component.svelte';\n`
	};
	for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(directory, file), content, { flag: 'wx' });
	return directory;
}

export default async function generateComponent(kind?: ComponentKind): Promise<void> {
	const workspace = await selectWorkspace();
	if (!workspace) return;
	if (!kind) {
		const answer = await prompts({
			type: 'select',
			name: 'kind',
			message: 'Component category:',
			choices: Object.entries(folders).map(([value, title]) => ({ value, title }))
		});
		if (!answer.kind) return;
		kind = answer.kind as ComponentKind;
	}
	let root = path.join(workspace.path, 'Ui', 'Components', folders[kind]);
	if (kind === 'scopes') {
		await fs.mkdir(root, { recursive: true });
		const existing = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
		const answer = await prompts({
			type: 'select',
			name: 'scope',
			message: 'UI scope:',
			choices: [...existing.map(({ name }) => ({ title: name, value: name })), { title: 'Create new scope', value: '__new__' }]
		});
		if (!answer.scope) return;
		let scope = answer.scope;
		if (scope === '__new__') {
			const created = await prompts({
				type: 'text',
				name: 'name',
				message: 'Scope name:',
				validate: (value: string) => {
					try {
						normalizePascalName(value);
						return true;
					} catch (error) {
						return (error as Error).message;
					}
				}
			});
			if (!created.name) return;
			scope = normalizePascalName(created.name);
		}
		root = path.join(root, scope);
	}
	const { name } = await prompts({
		type: 'text',
		name: 'name',
		message: 'Component name or relative path (e.g. Card or Catalog/Card):',
		validate: (value: string) => {
			try {
				return componentSegments(value).length > 0 || 'Component name is required';
			} catch (error) {
				return (error as Error).message;
			}
		}
	});
	if (!name) return;
	console.log(`Component generated: ${await writeComponent(root, name)}`);
}
