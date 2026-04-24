import checkPresenterNames from './checkPresenterNames.js';
import checkProviderNames from './checkProviderNames.js';
import checkDomain from './checkDomain.js';
import checkLayerBoundaries from './checkLayerBoundaries.js';
import checkFoldersStructure from './checkFoldersStructure.js';

type CheckTask = {
	name: string;
	run: () => Promise<void>;
};

const tasks: CheckTask[] = [
	{ name: 'presenter-names', run: checkPresenterNames },
	{ name: 'provider-names', run: checkProviderNames },
	{ name: 'domain', run: checkDomain },
	{ name: 'layer-boundaries', run: checkLayerBoundaries },
	{ name: 'folders-structure', run: checkFoldersStructure }
];

const runTask = async (task: CheckTask): Promise<void> => {
	console.log(`\n▶ Running check ${task.name}...`);
	process.exitCode = 0;
	await task.run();

	if ((process.exitCode ?? 0) !== 0) {
		throw new Error(`Check "${task.name}" failed`);
	}
};

export default async function checkInternal(): Promise<void> {
	try {
		for (const task of tasks) {
			await runTask(task);
		}
		console.log('\n✅ Internal checks passed.');
	} catch (error) {
		console.error(`\n❌ Internal checks failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
