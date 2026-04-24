import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import {
	appendRepositoryMethod,
	ensureDomainType,
	ensureRepositoryInterfaceFile,
	getAvailableTsNames,
	getConfigState,
	getRepositoryMeta,
	parseRepositoryMethods,
	resolveContextAlias,
	resolveRepositoriesPath,
	selectContext,
	promptMethodDefinition
} from './repositoryShared.js';

export default async function generateRepositoryMethod() {
	const contextName = await selectContext('Select context for repository method:');
	if (!contextName) {
		process.exitCode = 1;
		return;
	}

	const repositoriesPath = resolveRepositoriesPath(contextName);
	const repositories = await getAvailableTsNames(repositoriesPath);
	if (!repositories.length) {
		console.error(`❌ No repositories found in ${repositoriesPath}`);
		process.exitCode = 1;
		return;
	}

	const { repositoryName } = await prompts({
		type: 'select',
		name: 'repositoryName',
		message: 'Select repository:',
		choices: repositories.map((name) => ({ title: name, value: name })),
		initial: 0
	});

	if (!repositoryName) {
		process.exitCode = 1;
		return;
	}

	const meta = getRepositoryMeta(String(repositoryName));
	const repositoryPath = path.join(repositoriesPath, `${meta.className}.ts`);
	const method = await promptMethodDefinition();

	const ensuredResponseType = await ensureDomainType({
		contextName,
		domainName: meta.domainName,
		typeName: method.responseType,
		layer: method.responseLayer
	});
	method.responseType = ensuredResponseType.interfaceName;
	method.responseLayer = ensuredResponseType.layer;

	if (method.requestType) {
		const ensuredRequestType = await ensureDomainType({
			contextName,
			domainName: meta.domainName,
			typeName: method.requestType,
			layer: method.requestLayer ?? 'ports'
		});
		method.requestType = ensuredRequestType.interfaceName;
		method.requestLayer = ensuredRequestType.layer;
	}

	let repositoryContent = '';
	try {
		repositoryContent = await fs.readFile(repositoryPath, 'utf-8');
	} catch {
		console.error(`❌ Repository file not found: ${repositoryPath}`);
		process.exitCode = 1;
		return;
	}

	const existingMethods = parseRepositoryMethods(repositoryContent);
	if (existingMethods.some((item) => item.name === method.name)) {
		console.warn(`⚠️ Method "${method.name}" already exists in ${meta.className}.`);
		process.exitCode = 1;
		return;
	}

	const { contexts } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);
	await appendRepositoryMethod({
		repositoryPath,
		method,
		contextAlias,
		domainName: meta.domainName
	});

	await ensureRepositoryInterfaceFile({
		contextName,
		meta,
		methods: [...existingMethods, method]
	});

	console.log(`✅ Method "${method.name}" added to ${meta.className}`);
}
