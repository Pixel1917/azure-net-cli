import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';

type ConfigPath = 'ts' | 'js';

const createPresenterFactoryTemplate = (
	factoryName: string
): string => `import { createErrorHandler, createAsyncHelpers, createPresenterFactory } from '@azure-net/kit/delivery';

export const AsyncHelpers = createAsyncHelpers({ handler: createErrorHandler() });

export const ${factoryName} = createPresenterFactory({ ...AsyncHelpers });
`;

const resolveConfigFile = (cwd: string): { filepath: string; type: ConfigPath; exists: boolean; content: string } => {
	const tsPath = path.join(cwd, 'azure-net.config.ts');
	const jsPath = path.join(cwd, 'azure-net.config.js');

	if (fsSync.existsSync(tsPath)) {
		return { filepath: tsPath, type: 'ts', exists: true, content: fsSync.readFileSync(tsPath, 'utf-8') };
	}
	if (fsSync.existsSync(jsPath)) {
		return { filepath: jsPath, type: 'js', exists: true, content: fsSync.readFileSync(jsPath, 'utf-8') };
	}

	return { filepath: tsPath, type: 'ts', exists: false, content: '' };
};

const buildDefaultPresenterFactoryConfigEntry = (factoryName: string): string => {
	return `defaultPresenterFactory: '${factoryName}'`;
};

const upsertDefaultPresenterFactoryConfig = (content: string, factoryName: string): string => {
	const hasExportDefaultObject = /export\s+default\s*\{[\s\S]*\}\s*;?/.test(content);
	const defaultFactoryEntry = buildDefaultPresenterFactoryConfigEntry(factoryName);
	const coreAliasEntry = `coreAlias: '$core'`;

	if (!hasExportDefaultObject) {
		return `export default {\n\t${coreAliasEntry},\n\t${defaultFactoryEntry}\n};\n`;
	}

	let nextContent = content;

	if (/defaultPresenterFactory\s*:/.test(nextContent)) {
		nextContent = nextContent.replace(/defaultPresenterFactory\s*:\s*(\{[\s\S]*?\n\s*\}|['"`][^'"`]+['"`])/m, defaultFactoryEntry);
	} else if (/defaultPresenter\s*:/.test(nextContent)) {
		nextContent = nextContent.replace(/defaultPresenter\s*:\s*(\{[\s\S]*?\n\s*\}|['"`][^'"`]+['"`])/m, defaultFactoryEntry);
	} else {
		nextContent = nextContent.replace(/export\s+default\s*\{([\s\S]*)\}\s*;?/, (_full, body: string) => {
			const trimmedRight = body.replace(/\s*$/, '');
			if (!trimmedRight.length) {
				return `export default {\n\t${defaultFactoryEntry}\n};`;
			}

			const withComma = trimmedRight.endsWith(',') ? trimmedRight : `${trimmedRight},`;
			return `export default {${withComma}\n\t${defaultFactoryEntry}\n};`;
		});
	}

	if (/coreAlias\s*:/.test(nextContent)) {
		return nextContent.replace(/coreAlias\s*:\s*['"`][^'"`]+['"`]/, coreAliasEntry);
	}

	return nextContent.replace(/export\s+default\s*\{([\s\S]*)\}\s*;?/, (_full, body: string) => {
		const trimmedRight = body.replace(/\s*$/, '');
		if (!trimmedRight.length) {
			return `export default {\n\t${coreAliasEntry}\n};`;
		}

		const withComma = trimmedRight.endsWith(',') ? trimmedRight : `${trimmedRight},`;
		return `export default {${withComma}\n\t${coreAliasEntry}\n};`;
	});
};

export default async function createPresenterFactory(): Promise<void> {
	const { presenterFactoryNameRaw } = await prompts({
		type: 'text',
		name: 'presenterFactoryNameRaw',
		message: 'Presenter factory name:',
		initial: 'AppPresenter'
	});

	const presenterFactoryName = toPascalCase(String(presenterFactoryNameRaw ?? 'AppPresenter')) || 'AppPresenter';
	const presenterRootPath = path.join(process.cwd(), 'src', 'core', 'presenter');
	const filePath = path.join(presenterRootPath, `${presenterFactoryName}.ts`);

	await fs.mkdir(presenterRootPath, { recursive: true });

	const created = await writeIfNotExists(filePath, createPresenterFactoryTemplate(presenterFactoryName));
	if (!created) {
		console.log(`⚠️ Presenter factory "${presenterFactoryName}" already exists. File was not overwritten.`);
	} else {
		await updateIndexTs(presenterRootPath);
		console.log(`✅ Presenter factory created: ${filePath}`);
	}

	const { useAsDefault } = await prompts({
		type: 'confirm',
		name: 'useAsDefault',
		message: 'Use this presenter factory as default for the project?',
		initial: true
	});

	if (!useAsDefault) return;

	const config = resolveConfigFile(process.cwd());
	const nextContent = upsertDefaultPresenterFactoryConfig(config.content, presenterFactoryName);
	await fs.writeFile(config.filepath, nextContent, 'utf-8');
	console.log(`✅ Default presenter factory saved to ${path.basename(config.filepath)}`);
}
