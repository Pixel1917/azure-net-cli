import prompts from 'prompts';
import configureCommitTools from './configureCommitTools.js';
import initEdges from '../init/initEdges.js';
import initStructure from '../init/initStructure.js';
import { createCoreSchema, createDatasource, createProgram, createResponse, createTranslationManager } from '../scaffolds/index.js';

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
		throw new Error(`Step failed: ${question}`, { cause: error });
	}
	if (process.exitCode) throw new Error(`Step failed: ${question}`);
};

export default async function installFresh(): Promise<void> {
	await initStructure();
	await initEdges();
	await createProgram();

	await runOptionalStep('Add commit tools (lint/commit conventions)?', async () => {
		await configureCommitTools();
	});

	await runOptionalStep('Create schema factory?', async () => {
		await createCoreSchema();
	});

	await runOptionalStep('Create API response?', async () => {
		await createResponse();
	});

	await runOptionalStep('Create datasource?', async () => {
		await createDatasource();
	});

	await runOptionalStep('Create translation manager (i18n)?', async () => {
		await createTranslationManager();
	});

	console.log('✅ install fresh completed');
}
