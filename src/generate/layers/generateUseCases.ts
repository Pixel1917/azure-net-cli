import prompts from 'prompts';
import {
	ensureUseCasesFile,
	getAvailableTsNames,
	getConfigState,
	getRepositoryMeta,
	resolveContextAlias,
	resolveRepositoriesPath,
	selectContext
} from './repositoryShared.js';

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
		choices: repositories.map((name: string) => ({ title: name, value: name })),
		initial: 0
	});

	if (!repositoryName) {
		process.exitCode = 1;
		return;
	}

	const { contexts } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);
	const meta = getRepositoryMeta(String(repositoryName));
	const created = await ensureUseCasesFile({ contextName, contextAlias, meta });
	if (!created) {
		process.exitCode = 1;
		return;
	}

	console.log(`✅ UseCases generated: ${meta.useCasesClassName}`);
}
