import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { selectContext, toPascalCase } from '../../utils/contextUtils.js';
import { appendBarrelExports, updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';

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
		if (!/^I[A-Z][A-Za-z0-9]*$/.test(name)) {
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
	await appendBarrelExports(path.join(domainPath, 'index.ts'), ['./Entities', './Ports', './Enums']);
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
	let context: string | null = options.contextName ? String(options.contextName) : null;
	if (!context) {
		context = await selectContext();
	}
	if (!context) {
		process.exitCode = 1;
		return null;
	}

	context = toPascalCase(context);
	const domainPath = path.join(process.cwd(), 'src/app/Contexts', context, 'Domain');
	const modelPath = path.join(domainPath, 'Entities');
	const portsPath = path.join(domainPath, 'Ports');

	await fs.mkdir(modelPath, { recursive: true });
	await fs.mkdir(portsPath, { recursive: true });

	const { shouldCreateModels } = await prompts({
		type: 'confirm',
		name: 'shouldCreateModels',
		message: 'Create entity interfaces?',
		initial: true
	});

	if (shouldCreateModels) {
		const { modelNamesRaw } = await prompts({
			type: 'text',
			name: 'modelNamesRaw',
			message: 'Entity interface names (comma separated, start with I):',
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

	await fs.mkdir(path.join(domainPath, 'Enums'), { recursive: true });
	await updateIndexTs(path.join(domainPath, 'Enums'));
	await writeRootIndex(domainPath);
	console.log(`✅ Domain generated: ${domainPath}`);
	return { contextName: context, domainName: context, domainPath };
}
