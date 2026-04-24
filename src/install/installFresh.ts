import prompts from 'prompts';
import { addLint } from '../plugins/index.js';
import initEdges from '../init/initEdges.js';
import initStructure from '../init/initStructure.js';
import { normalizeContexts } from '../init/initAliases.js';
import { loadUserConfig } from '../utils/loadConfig.js';
import {
	createCoreMiddleware,
	createCoreSchema,
	createDatasource,
	createDatasourceProvider,
	createMiddleware,
	createPresenterFactory,
	createResponse,
	createTranslationManager
} from '../scaffolds/index.js';

const printContextsError = (): void => {
	console.error('❌ Cannot run "install fresh": `contexts` is missing or empty in azure-net.config.ts/js');
	console.error('Add contexts first, for example:');
	console.error('export default {');
	console.error("\tcontexts: ['web', 'admin']");
	console.error('\t// or');
	console.error("\t// contexts: [{ name: 'web', alias: '$web' }, { name: 'admin', alias: '$admin' }]");
	console.error('};');
};

const askConfirm = async (message: string): Promise<boolean> => {
	const result = await prompts({
		type: 'confirm',
		name: 'confirmed',
		message,
		initial: true
	});

	return Boolean(result.confirmed);
};

const runOptionalStep = async (question: string, action: () => Promise<void>): Promise<void> => {
	const shouldRun = await askConfirm(question);
	if (!shouldRun) return;

	try {
		await action();
	} catch (error) {
		console.warn(`⚠️ Step failed: ${question}`);
		console.warn(error);
	}
};

export default async function installFresh(): Promise<void> {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);

	if (!contexts.length) {
		printContextsError();
		process.exitCode = 1;
		return;
	}

	await initStructure();
	await initEdges();

	await runOptionalStep('Add commit tools (lint/commit conventions)?', async () => {
		await addLint();
	});

	await runOptionalStep('Create middleware manager?', async () => {
		await createCoreMiddleware();
	});

	await runOptionalStep('Create starter middleware?', async () => {
		await createMiddleware();
	});

	await runOptionalStep('Create schema factory?', async () => {
		await createCoreSchema();
	});

	await runOptionalStep('Create presenter factory?', async () => {
		await createPresenterFactory();
	});

	await runOptionalStep('Create API response?', async () => {
		await createResponse();
	});

	await runOptionalStep('Create datasource?', async () => {
		await createDatasource();
	});

	await runOptionalStep('Create datasource provider?', async () => {
		await createDatasourceProvider();
	});

	await runOptionalStep('Create translation manager (i18n)?', async () => {
		await createTranslationManager();
	});

	console.log('✅ install fresh completed');
}
