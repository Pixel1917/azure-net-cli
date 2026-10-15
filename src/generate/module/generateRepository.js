import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { buildRepositoryContent, createUseCasesForRepository, ensureRepositoryName, getConfigState, getDomainTypes, getRepositoryMeta, promptMethodsBatch, resolveContextAlias, resolveRepositoriesPath, selectContext, selectDatasource, writeRepositoryInterface } from './repositoryModuleShared.js';
import { updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';
export default async function generateRepository(options = {}) {
    let contextName = options.contextName ? String(options.contextName) : null;
    if (!contextName) {
        contextName = await selectContext('Select context for repository:');
    }
    if (!contextName) {
        process.exitCode = 1;
        return null;
    }
    const domainName = contextName;
    const { repositoryNameRaw } = await prompts({
        type: 'text',
        name: 'repositoryNameRaw',
        message: 'Repository name:',
        validate: (value) => (String(value ?? '').trim().length > 0 ? true : 'Repository name is required')
    });
    const className = ensureRepositoryName(repositoryNameRaw);
    const meta = getRepositoryMeta(className);
    const datasource = await selectDatasource(contextName);
    if (!datasource) {
        process.exitCode = 1;
        return null;
    }
    const domainTypes = await getDomainTypes(contextName, domainName);
    const { methodsCountRaw } = await prompts({
        type: 'number',
        name: 'methodsCountRaw',
        message: 'How many methods to create?',
        initial: 1,
        min: 0
    });
    const methodsCount = Number(methodsCountRaw ?? 0);
    if (!Number.isInteger(methodsCount) || methodsCount < 0) {
        console.error('❌ Invalid methods count.');
        process.exitCode = 1;
        return null;
    }
    const methods = await promptMethodsBatch(domainTypes, methodsCount);
    if (!methods) {
        process.exitCode = 1;
        return null;
    }
    const { contexts } = await getConfigState();
    const contextAlias = resolveContextAlias(contexts, contextName);
    const repositoriesPath = resolveRepositoriesPath(contextName);
    await fs.mkdir(repositoriesPath, { recursive: true });
    const repositoryPath = path.join(repositoriesPath, `${meta.className}.ts`);
    const interfaceCreated = await writeRepositoryInterface({
        contextName,
        domainName,
        meta,
        methods
    });
    if (!interfaceCreated)
        throw new Error('Repository interface already exists; no repository was generated.');
    const repositoryContent = buildRepositoryContent({
        meta,
        contextAlias,
        domainName,
        datasource,
        domainTypes,
        methods
    });
    const created = await writeIfNotExists(repositoryPath, repositoryContent);
    await updateIndexTs(repositoriesPath);
    if (!created) {
        console.warn(`⚠️ Repository "${meta.className}" already exists. File was not overwritten.`);
        process.exitCode = 1;
        return null;
    }
    const { shouldCreateUseCases } = await prompts({
        type: 'confirm',
        name: 'shouldCreateUseCases',
        message: 'Create UseCases for this repository?',
        initial: true
    });
    let useCasesCreated = false;
    if (shouldCreateUseCases) {
        useCasesCreated = await createUseCasesForRepository({
            contextName,
            contextAlias,
            domainName,
            repositoryName: meta.className
        });
    }
    if (!shouldCreateUseCases && options.forceCreateUseCases) {
        useCasesCreated = await createUseCasesForRepository({
            contextName,
            contextAlias,
            domainName,
            repositoryName: meta.className
        });
    }
    console.log(`✅ Repository generated: ${repositoryPath}`);
    return {
        contextName,
        domainName,
        repositoryName: meta.className,
        useCasesName: meta.useCasesClassName,
        useCasesCreated,
        datasourceName: datasource.name
    };
}
