import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';

type MessagePreset = 'ru' | 'en' | 'i18n';
type ConfigPath = 'ts' | 'js';

const resolvePresetImportName = (preset: MessagePreset): string => {
	switch (preset) {
		case 'ru':
			return 'validationMessagesRu';
		case 'en':
			return 'validationMessagesEn';
		case 'i18n':
			return 'validationMessagesI18n';
	}
};

const createSchemaFactoryTemplate = (
	factoryName: string,
	messagesImportName: string
): string => `import { createSchemaFactory, createRules, ${messagesImportName} } from '@azure-net/kit/delivery';

export const ${factoryName} = createSchemaFactory(createRules(${messagesImportName}));
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

const buildDefaultSchemaFactoryConfigEntry = (factoryName: string): string => {
	return `defaultSchemaFactory: '${factoryName}'`;
};

const upsertDefaultSchemaFactoryConfig = (content: string, factoryName: string): string => {
	const hasExportDefaultObject = /export\s+default\s*\{[\s\S]*\}\s*;?/.test(content);
	const defaultFactoryEntry = buildDefaultSchemaFactoryConfigEntry(factoryName);
	const coreAliasEntry = `coreAlias: '$core'`;

	if (!hasExportDefaultObject) {
		return `export default {\n\t${coreAliasEntry},\n\t${defaultFactoryEntry}\n};\n`;
	}

	let nextContent = content;

	if (/defaultSchemaFactory\s*:/.test(nextContent)) {
		nextContent = nextContent.replace(/defaultSchemaFactory\s*:\s*(\{[\s\S]*?\n\s*\}|['"`][^'"`]+['"`])/m, defaultFactoryEntry);
	} else if (/defaultSchema\s*:/.test(nextContent)) {
		nextContent = nextContent.replace(/defaultSchema\s*:\s*(\{[\s\S]*?\n\s*\}|['"`][^'"`]+['"`])/m, defaultFactoryEntry);
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

export default async function createCoreSchema(): Promise<void> {
	const { schemaFactoryNameRaw } = await prompts({
		type: 'text',
		name: 'schemaFactoryNameRaw',
		message: 'Schema factory name:',
		initial: 'Schema'
	});

	const schemaFactoryName = toPascalCase(String(schemaFactoryNameRaw ?? 'Schema')) || 'Schema';

	const { preset } = await prompts({
		type: 'select',
		name: 'preset',
		message: 'Choose validation messages:',
		choices: [
			{ title: 'Russian', value: 'ru' },
			{ title: 'English', value: 'en' },
			{ title: 'i18n', value: 'i18n' }
		],
		initial: 2
	});

	const selectedPreset = (preset ?? 'i18n') as MessagePreset;
	const messagesImportName = resolvePresetImportName(selectedPreset);
	const coreSchemaPath = path.join(process.cwd(), 'src', 'core', 'schema');
	const customRulesPath = path.join(coreSchemaPath, 'custom-rules');
	const filePath = path.join(coreSchemaPath, `${schemaFactoryName}.ts`);

	await fs.mkdir(coreSchemaPath, { recursive: true });
	await fs.mkdir(customRulesPath, { recursive: true });

	const created = await writeIfNotExists(filePath, createSchemaFactoryTemplate(schemaFactoryName, messagesImportName));
	if (!created) {
		console.log(`⚠️ Schema factory "${schemaFactoryName}" already exists. File was not overwritten.`);
	} else {
		await updateIndexTs(coreSchemaPath);
		console.log(`✅ Core schema factory created: ${filePath}`);
	}

	const { useAsDefault } = await prompts({
		type: 'confirm',
		name: 'useAsDefault',
		message: 'Use this schema factory as default for the project?',
		initial: true
	});

	if (!useAsDefault) return;

	const config = resolveConfigFile(process.cwd());
	const nextContent = upsertDefaultSchemaFactoryConfig(config.content, schemaFactoryName);
	await fs.writeFile(config.filepath, nextContent, 'utf-8');
	console.log(`✅ Default schema factory saved to ${path.basename(config.filepath)}`);
}
