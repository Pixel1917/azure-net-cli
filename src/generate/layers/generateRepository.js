import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import {
	buildRepositoryContent,
	ensureDomainType,
	ensureRepositoryInterfaceFile,
	ensureRepositoryName,
	ensureUseCasesFile,
	getConfigState,
	getRepositoryMeta,
	resolveContextAlias,
	resolveRepositoriesPath,
	selectContext,
	selectDatasource,
	promptMethodDefinition
} from './repositoryShared.js';
import { updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';

export default async function generateRepository() {
	const { rawName } = await prompts({
		type: 'text',
		name: 'rawName',
		message: 'Repository name:',
		validate: (value) => (String(value ?? '').trim().length > 0 ? true : 'Repository name is required')
	});

	const className = ensureRepositoryName(rawName);
	const meta = getRepositoryMeta(className);
	const contextName = await selectContext('Select context for repository:');
	if (!contextName) {
		process.exitCode = 1;
		return;
	}

	const datasource = await selectDatasource(contextName);
	if (!datasource) {
		process.exitCode = 1;
		return;
	}

	const { methodsCountRaw } = await prompts({
		type: 'number',
		name: 'methodsCountRaw',
		message: 'How many methods to create?',
		initial: 1,
		min: 0
	});

	const methodsCount = Number(methodsCountRaw ?? 0);
	if (!Number.isFinite(methodsCount) || methodsCount < 0) {
		console.error('❌ Invalid methods count.');
		process.exitCode = 1;
		return;
	}

	const methods = [];
	for (let index = 0; index < methodsCount; index += 1) {
		console.log(`\n🧩 Method ${index + 1} of ${methodsCount}`);
		// eslint-disable-next-line no-await-in-loop
		const method = await promptMethodDefinition();
		methods.push(method);
	}

	const { contexts } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);
	const repositoriesPath = resolveRepositoriesPath(contextName);
	await fs.mkdir(repositoriesPath, { recursive: true });
	const repositoryPath = path.join(repositoriesPath, `${meta.className}.ts`);

	for (const method of methods) {
		// eslint-disable-next-line no-await-in-loop
		const ensuredResponseType = await ensureDomainType({
			contextName,
			domainName: meta.domainName,
			typeName: method.responseType,
			layer: method.responseLayer
		});
		method.responseType = ensuredResponseType.interfaceName;
		method.responseLayer = ensuredResponseType.layer;

		if (method.requestType) {
			// eslint-disable-next-line no-await-in-loop
			const ensuredRequestType = await ensureDomainType({
				contextName,
				domainName: meta.domainName,
				typeName: method.requestType,
				layer: method.requestLayer ?? 'ports'
			});
			method.requestType = ensuredRequestType.interfaceName;
			method.requestLayer = ensuredRequestType.layer;
		}
	}

	await ensureRepositoryInterfaceFile({ contextName, meta, methods });
	const repositoryContent = buildRepositoryContent({
		meta,
		contextAlias,
		datasourceImportPath: datasource.importPath,
		datasourceName: datasource.name,
		methods
	});

	const created = await writeIfNotExists(repositoryPath, repositoryContent);
	await updateIndexTs(repositoriesPath);
	if (!created) {
		console.warn(`⚠️ Repository "${meta.className}" already exists. File was not overwritten.`);
		process.exitCode = 1;
		return;
	}

	const { shouldCreateUseCases } = await prompts({
		type: 'confirm',
		name: 'shouldCreateUseCases',
		message: 'Create UseCases for this repository?',
		initial: true
	});

	if (shouldCreateUseCases) {
		await ensureUseCasesFile({ contextName, contextAlias, meta });
	}

	console.log(`✅ Repository generated: ${repositoryPath}`);
}
