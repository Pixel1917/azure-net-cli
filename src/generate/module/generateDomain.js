import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { selectContext } from './repositoryModuleShared.js';
import { selectAggregate, getAggregatePath } from '../../utils/architecture.js';
import { toPascalCase } from '../../utils/contextUtils.js';
import { appendBarrelExports, updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';
const parseInterfaceNames = (rawValue) => String(rawValue ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => toPascalCase(item))
    .filter(Boolean);
const toFileNameFromInterface = (interfaceName) => interfaceName.replace(/^I/, '') || 'Type';
const validateInterfaceNames = (rawValue) => {
    const names = parseInterfaceNames(rawValue);
    if (!names.length)
        return 'Provide at least one interface name';
    for (const name of names) {
        if (!/^I[A-Z][A-Za-z0-9]*$/.test(name)) {
            return `Interface "${name}" must start with "I"`;
        }
    }
    return true;
};
const createInterfaceContent = (name) => `export interface ${name} {
\t[key: string]: unknown;
}
`;
const writeRootIndex = async (domainPath) => {
    await appendBarrelExports(path.join(domainPath, 'index.ts'), ['./Resources', './DTO', './Ports', './Enums']);
};
const createInterfacesInLayer = async (layerPath, names) => {
    for (const interfaceName of names) {
        const fileName = toFileNameFromInterface(interfaceName);
        const filePath = path.join(layerPath, `${fileName}.ts`);
        await writeIfNotExists(filePath, createInterfaceContent(interfaceName));
    }
    await updateIndexTs(layerPath);
};
export default async function generateDomain(options = {}) {
    let context = options.contextName ? String(options.contextName) : null;
    if (!context) {
        context = await selectContext();
    }
    if (!context) {
        process.exitCode = 1;
        return null;
    }
    context = toPascalCase(context);
    const aggregate = options.aggregateName ?? (await selectAggregate(context));
    if (!aggregate)
        return null;
    const domainPath = path.join(getAggregatePath(context, aggregate), 'Domain');
    const modelPath = path.join(domainPath, 'Resources');
    const portsPath = path.join(domainPath, 'DTO');
    await fs.mkdir(path.join(domainPath, 'Ports'), { recursive: true });
    await updateIndexTs(path.join(domainPath, 'Ports'));
    await fs.mkdir(modelPath, { recursive: true });
    await fs.mkdir(portsPath, { recursive: true });
    const { shouldCreateModels } = await prompts({
        type: 'confirm',
        name: 'shouldCreateModels',
        message: 'Create resource interfaces?',
        initial: true
    });
    if (shouldCreateModels) {
        const { modelNamesRaw } = await prompts({
            type: 'text',
            name: 'modelNamesRaw',
            message: 'Resource interface names (ending in Resource) (comma separated, start with I):',
            validate: validateInterfaceNames
        });
        const modelNames = parseInterfaceNames(modelNamesRaw);
        if (modelNames.some((n) => !n.endsWith('Resource')))
            throw new Error('Resource interfaces must end in Resource.');
        await createInterfacesInLayer(modelPath, modelNames);
    }
    else {
        await updateIndexTs(modelPath);
    }
    const { shouldCreatePorts } = await prompts({
        type: 'confirm',
        name: 'shouldCreatePorts',
        message: 'Create DTO interfaces?',
        initial: true
    });
    if (shouldCreatePorts) {
        const { portNamesRaw } = await prompts({
            type: 'text',
            name: 'portNamesRaw',
            message: 'DTO interface names (comma separated, start with I):',
            validate: validateInterfaceNames
        });
        const portNames = parseInterfaceNames(portNamesRaw);
        await createInterfacesInLayer(portsPath, portNames);
    }
    else {
        await updateIndexTs(portsPath);
    }
    await fs.mkdir(path.join(domainPath, 'Enums'), { recursive: true });
    await updateIndexTs(path.join(domainPath, 'Enums'));
    await writeRootIndex(domainPath);
    console.log(`✅ Domain generated: ${domainPath}`);
    return { contextName: context, domainName: aggregate, domainPath };
}
