import prompts from 'prompts';
import {
	createUseCasesForRepository,
	getAvailableTsNames,
	getConfigState,
	resolveContextAlias,
	resolveDomainForRepository,
	resolveRepositoriesPath,
	selectContext
} from './repositoryModuleShared.js';

export default async function generateUseCases(): Promise<void> {
	const contextName = await selectContext('Select context for UseCases:');
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
		choices: repositories.map((item) => ({ title: item, value: item })),
		initial: 0
	});

	if (!repositoryName) {
		process.exitCode = 1;
		return;
	}

	const { contexts } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);
	const domainName = await resolveDomainForRepository({
		contextName,
		contextAlias,
		repositoryName: String(repositoryName)
	});

	if (!domainName) {
		console.error('❌ Unable to resolve domain from repository imports.');
		process.exitCode = 1;
		return;
	}

	const created = await createUseCasesForRepository({
		contextName,
		contextAlias,
		domainName,
		repositoryName: String(repositoryName)
	});

	if (!created) {
		process.exitCode = 1;
		return;
	}

	console.log(`✅ UseCases generated for ${repositoryName}`);
}
