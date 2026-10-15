import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toPascalCase } from '../../utils/contextUtils.js';
import { appendBarrelExports, updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';
import generatePresenter from './generatePresenter.js';
import { buildRepositoryContent, createUseCasesForRepository, getAvailableTsNames, getConfigState, getRepositoryMeta, resolveContextAlias, resolveDomainRootPath, resolveRepositoriesPath, resolveSharedDatasourcesPath, selectContext, printApplicationProviderWiring, writeRepositoryInterface } from './repositoryModuleShared.js';
const toInterfaceFileName = (interfaceName) => `${String(interfaceName ?? '').replace(/^I/, '') || 'Type'}.ts`;
const createInterfaceContent = (interfaceName) => `export interface ${interfaceName} {
\t[key: string]: unknown;
}
`;
const writeDomainIndexes = async (domainPath, modelPath, portsPath) => {
    await updateIndexTs(modelPath);
    await updateIndexTs(portsPath);
    await appendBarrelExports(path.join(domainPath, 'index.ts'), ['./Entities', './Ports', './Enums']);
};
const ensureDomainScaffold = async ({ contextName, entityNamePascal, domainName }) => {
    const domainPath = resolveDomainRootPath(contextName, domainName);
    const modelPath = path.join(domainPath, 'Entities');
    const portsPath = path.join(domainPath, 'Ports');
    await fs.mkdir(modelPath, { recursive: true });
    await fs.mkdir(portsPath, { recursive: true });
    const modelInterfaces = [`I${entityNamePascal}`];
    const portInterfaces = [
        `I${entityNamePascal}CreateRequest`,
        `I${entityNamePascal}UpdateRequest`,
        `I${entityNamePascal}CollectionResponse`,
        `I${entityNamePascal}CollectionQuery`
    ];
    for (const interfaceName of modelInterfaces) {
        const filePath = path.join(modelPath, toInterfaceFileName(interfaceName));
        await writeIfNotExists(filePath, createInterfaceContent(interfaceName));
    }
    for (const interfaceName of portInterfaces) {
        const filePath = path.join(portsPath, toInterfaceFileName(interfaceName));
        await writeIfNotExists(filePath, createInterfaceContent(interfaceName));
    }
    await fs.mkdir(path.join(domainPath, 'Enums'), { recursive: true });
    await updateIndexTs(path.join(domainPath, 'Enums'));
    await writeDomainIndexes(domainPath, modelPath, portsPath);
    return { domainPath, modelPath, portsPath };
};
const resolveDatasourceForPreset = async () => {
    const names = await getAvailableTsNames(await resolveSharedDatasourcesPath());
    const name = names.includes('ApiDatasource') ? 'ApiDatasource' : names[0];
    return name ? { name, importPath: '#platform/Foundation/Datasource' } : null;
};
const buildPresetMethods = ({ entityNamePascal, route, pathParamType }) => [
    {
        name: 'collection',
        httpMethod: 'get',
        route,
        response: { kind: 'domain', type: `I${entityNamePascal}CollectionResponse`, layer: 'Ports' },
        queryType: { name: `I${entityNamePascal}CollectionQuery`, layer: 'Ports' },
        bodyType: null,
        pathParamType: null
    },
    {
        name: 'resource',
        httpMethod: 'get',
        route,
        response: { kind: 'domain', type: `I${entityNamePascal}`, layer: 'Entities' },
        queryType: null,
        bodyType: null,
        pathParamType
    },
    {
        name: 'create',
        httpMethod: 'post',
        route,
        response: { kind: 'domain', type: `I${entityNamePascal}`, layer: 'Entities' },
        queryType: null,
        bodyType: { name: `I${entityNamePascal}CreateRequest`, layer: 'Ports' },
        pathParamType: null
    },
    {
        name: 'update',
        httpMethod: 'put',
        route,
        response: { kind: 'domain', type: `I${entityNamePascal}`, layer: 'Entities' },
        queryType: null,
        bodyType: { name: `I${entityNamePascal}UpdateRequest`, layer: 'Ports' },
        pathParamType
    },
    {
        name: 'destroy',
        httpMethod: 'delete',
        route,
        response: { kind: 'primitive', type: 'never', layer: null },
        queryType: null,
        bodyType: null,
        pathParamType
    }
];
export default async function generateModulePreset() {
    const contextName = await selectContext('Select context for preset module:');
    if (!contextName) {
        process.exitCode = 1;
        return;
    }
    const { entityNameRaw } = await prompts({
        type: 'text',
        name: 'entityNameRaw',
        message: 'Module name:',
        validate: (value) => (String(value ?? '').trim().length > 0 ? true : 'Module name is required')
    });
    const { routeRaw } = await prompts({
        type: 'text',
        name: 'routeRaw',
        message: 'Base request path (e.g. /users):',
        initial: '/resource',
        validate: (value) => {
            const route = String(value ?? '').trim();
            if (!route.length)
                return 'Path is required';
            return route.startsWith('/') ? true : 'Path must start with "/"';
        }
    });
    const { pathParamType } = await prompts({
        type: 'select',
        name: 'pathParamType',
        message: 'Path param type:',
        choices: [
            { title: 'string', value: 'string' },
            { title: 'number', value: 'number' }
        ],
        initial: 0
    });
    const entityNamePascal = toPascalCase(String(entityNameRaw ?? '').trim());
    if (!entityNamePascal) {
        console.error('❌ Invalid module name.');
        process.exitCode = 1;
        return;
    }
    const route = String(routeRaw ?? '').trim();
    if (!route) {
        console.error('❌ Invalid route.');
        process.exitCode = 1;
        return;
    }
    const resolvedPathParamType = pathParamType === 'number' ? 'number' : 'string';
    const domainName = contextName;
    await ensureDomainScaffold({ contextName, entityNamePascal, domainName });
    const datasource = await resolveDatasourceForPreset();
    if (!datasource) {
        console.error('❌ No datasource found in Platform/Foundation/Datasource. Create datasource first.');
        process.exitCode = 1;
        return;
    }
    const methods = buildPresetMethods({
        entityNamePascal,
        route,
        pathParamType: resolvedPathParamType
    });
    const repositoryClassName = `${entityNamePascal}Repository`;
    const meta = getRepositoryMeta(repositoryClassName);
    const { contexts } = await getConfigState();
    const contextAlias = resolveContextAlias(contexts, contextName);
    await writeRepositoryInterface({
        contextName,
        domainName,
        meta,
        methods
    });
    const repositoryContent = buildRepositoryContent({
        meta,
        contextAlias,
        domainName,
        datasource,
        methods
    });
    const repositoriesPath = resolveRepositoriesPath(contextName);
    await fs.mkdir(repositoriesPath, { recursive: true });
    const repositoryPath = path.join(repositoriesPath, `${meta.className}.ts`);
    const createdRepository = await writeIfNotExists(repositoryPath, repositoryContent);
    await updateIndexTs(repositoriesPath);
    if (!createdRepository) {
        console.error(`❌ Repository "${meta.className}" already exists. Preset flow stopped.`);
        process.exitCode = 1;
        return;
    }
    await createUseCasesForRepository({
        contextName,
        contextAlias,
        domainName,
        repositoryName: meta.className
    });
    printApplicationProviderWiring(contextName, meta.className, datasource.name);
    const { readyAnswer } = await prompts({
        type: 'text',
        name: 'readyAnswer',
        message: 'Type "y" when provider wiring is done:'
    });
    const normalizedReadyAnswer = String(readyAnswer ?? '')
        .trim()
        .toLowerCase();
    if (normalizedReadyAnswer !== 'y') {
        console.log('ℹ️ Preset module flow paused. Complete provider wiring and run `azure-net generate presenter`.');
        return;
    }
    await generatePresenter({
        contextName,
        useCasesName: meta.useCasesClassName
    });
}
