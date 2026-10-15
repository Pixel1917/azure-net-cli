import checkProject from '../checks/checkProject.js';
import { loadUserConfig } from '../utils/loadConfig.js';
import commit, { type CommitDependencies } from './commit.js';
import { runGit } from './runGit.js';

export interface PushOptions {
	check?: boolean;
}

export interface PushDependencies extends CommitDependencies {
	loadConfig?: () => Promise<{ runChecksBeforePush?: unknown }>;
	checkProject?: () => Promise<void>;
}

export default async function push(options: PushOptions = {}, dependencies: PushDependencies = {}): Promise<void> {
	const git = dependencies.git ?? runGit;
	if (options.check !== false) {
		const config = await (dependencies.loadConfig ?? loadUserConfig)();
		if (config.runChecksBeforePush !== false) {
			await (dependencies.checkProject ?? checkProject)();
			// checkProject catches failures and communicates them through exitCode.
			if (process.exitCode && process.exitCode !== '0') throw new Error('Project checks failed; push stopped.');
		}
	}
	await git(['add', '.']);
	await commit({ prompt: dependencies.prompt, git });
	await git(['push']);
}
