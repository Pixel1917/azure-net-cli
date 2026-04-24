import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { normalizeContexts } from '../../init/initAliases.js';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { toKebabCase, toPascalCase } from '../../utils/contextUtils.js';
import { updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';

const parseInterfaceNames = (rawValue: unknown): string[] =>
	String(rawValue ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => toPascalCase(item))
		.filter(Boolean);

const toFileNameFromInterface = (interfaceName: string): string => interfaceName.replace(/^I/, '') || 'Type';

const validateInterfaceNames = (rawValue: unknown): true | string => {
	const names = parseInterfaceNames(rawValue);
	if (!names.length) return 'Provide at least one interface name';

	for (const name of names) {
		if (!name.startsWith('I')) {
			return `Interface "${name}" must start with "I"`;
		}
	}

	return true;
};

const createInterfaceContent = (name: string): string => `export interface ${name} {
\t[key: string]: unknown;
}
`;

const writeRootIndex = async (domainPath: string): Promise<void> => {
	const content = `export * from './model';
export * from './ports';
`;

	await fs.writeFile(path.join(domainPath, 'index.ts'), content, 'utf-8');
};

const selectContext = async (): Promise<string | null> => {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);
	if (!contexts.length) {
		console.error('❌ Cannot generate domain: `contexts` is missing or empty in azure-net.config.ts/js');
		return null;
	}

	const { context } = await prompts({
		type: 'select',
		name: 'context',
		message: 'Select context:',
		choices: contexts.map((item) => ({ title: item.name, value: item.name })),
		initial: 0
	});

	return context ? String(context) : null;
};

const createInterfacesInLayer = async (layerPath: string, names: string[]): Promise<void> => {
	for (const interfaceName of names) {
		const fileName = toFileNameFromInterface(interfaceName);
		const filePath = path.join(layerPath, `${fileName}.ts`);
		await writeIfNotExists(filePath, createInterfaceContent(interfaceName));
	}

	await updateIndexTs(layerPath);
};

export default async function generateDomain(
	options: { contextName?: string; entityName?: string } = {}
): Promise<{ contextName: string; domainName: string; domainPath: string } | null> {
	const { entityRaw } = await prompts({
		type: 'text',
		name: 'entityRaw',
		message: 'Entity name:',
		initial: options.entityName ?? '',
		validate: (value: string) => (String(value ?? '').trim().length > 0 ? true : 'Entity name is required')
	});

	let context: string | null = options.contextName ? String(options.contextName) : null;
	if (!context) {
		context = await selectContext();
	}
	if (!context) {
		process.exitCode = 1;
		return null;
	}

	const entityName = toKebabCase(String(entityRaw ?? '').trim()) || 'entity';
	const domainPath = path.join(process.cwd(), 'src', 'app', context, 'layers', 'domain', entityName);
	const modelPath = path.join(domainPath, 'model');
	const portsPath = path.join(domainPath, 'ports');

	await fs.mkdir(modelPath, { recursive: true });
	await fs.mkdir(portsPath, { recursive: true });

	const { shouldCreateModels } = await prompts({
		type: 'confirm',
		name: 'shouldCreateModels',
		message: 'Create model interfaces?',
		initial: true
	});

	if (shouldCreateModels) {
		const { modelNamesRaw } = await prompts({
			type: 'text',
			name: 'modelNamesRaw',
			message: 'Model interface names (comma separated, start with I):',
			validate: validateInterfaceNames
		});

		const modelNames = parseInterfaceNames(modelNamesRaw);
		await createInterfacesInLayer(modelPath, modelNames);
	} else {
		await updateIndexTs(modelPath);
	}

	const { shouldCreatePorts } = await prompts({
		type: 'confirm',
		name: 'shouldCreatePorts',
		message: 'Create port interfaces?',
		initial: true
	});

	if (shouldCreatePorts) {
		const { portNamesRaw } = await prompts({
			type: 'text',
			name: 'portNamesRaw',
			message: 'Port interface names (comma separated, start with I):',
			validate: validateInterfaceNames
		});

		const portNames = parseInterfaceNames(portNamesRaw);
		await createInterfacesInLayer(portsPath, portNames);
	} else {
		await updateIndexTs(portsPath);
	}

	await writeRootIndex(domainPath);
	console.log(`✅ Domain generated: ${domainPath}`);
	return { contextName: context, domainName: entityName, domainPath };
}
