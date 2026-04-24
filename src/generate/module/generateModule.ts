import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import generateDomain from './generateDomain.js';
import generateRepository from './generateRepository.js';
import generatePresenter from './generatePresenter.js';

const findProviderFile = async (contextName: string, layerName: string, preferredFileName: string): Promise<string> => {
	const providersPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', layerName, 'providers');
	const preferredPath = path.join(providersPath, preferredFileName);
	try {
		await fs.access(preferredPath);
		return preferredPath;
	} catch {
		try {
			const files = await fs.readdir(providersPath);
			const firstTs = files.find((item) => item.endsWith('.ts') && item !== 'index.ts');
			return firstTs ? path.join(providersPath, firstTs) : preferredPath;
		} catch {
			return preferredPath;
		}
	}
};

const parseProviderConstName = async (providerPath: string, fallbackName: string): Promise<string> => {
	try {
		const content = await fs.readFile(providerPath, 'utf-8');
		const match = content.match(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*createBoundaryProvider/);
		return match?.[1] ?? fallbackName;
	} catch {
		return fallbackName;
	}
};

export default async function generateModule(): Promise<void> {
	const domainResult = await generateDomain();
	if (!domainResult) {
		process.exitCode = 1;
		return;
	}

	const repositoryResult = await generateRepository({
		contextName: domainResult.contextName,
		domainName: domainResult.domainName,
		forceCreateUseCases: true
	});

	if (!repositoryResult) {
		process.exitCode = 1;
		return;
	}

	const infrastructureProviderPath = await findProviderFile(repositoryResult.contextName, 'infrastructure', 'InfrastructureProvider.ts');
	const applicationProviderPath = await findProviderFile(repositoryResult.contextName, 'application', 'ApplicationProvider.ts');
	const infrastructureProviderName = await parseProviderConstName(infrastructureProviderPath, 'InfrastructureProvider');

	console.log('\n⚠️ Manual provider registration is required before presenter generation.');
	console.log(`Infrastructure provider file: ${infrastructureProviderPath}`);
	console.log(`Application provider file: ${applicationProviderPath}`);
	console.log('\nSuggested register snippets:');
	console.log(
		`- Infrastructure register: ${repositoryResult.repositoryName}: () => new ${repositoryResult.repositoryName}(/* datasource */),`
	);
	console.log(
		`- Application register: ${repositoryResult.useCasesName}: () => new ${repositoryResult.useCasesName}(${infrastructureProviderName}().${repositoryResult.repositoryName}),`
	);

	const { isReadyForPresenter } = await prompts({
		type: 'confirm',
		name: 'isReadyForPresenter',
		message: 'Did you register repository/use-cases in providers and want to continue?',
		initial: false
	});

	if (!isReadyForPresenter) {
		console.log('ℹ️ Module flow paused. Complete provider wiring and rerun `azure-net generate presenter`.');
		return;
	}

	await generatePresenter({
		contextName: repositoryResult.contextName,
		useCasesName: repositoryResult.useCasesName
	});
}
