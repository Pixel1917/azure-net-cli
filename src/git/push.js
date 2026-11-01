import checkProject from '../checks/checkProject.js';
import { loadUserConfig } from '../utils/loadConfig.js';
import commit from './commit.js';
import { runGit } from './runGit.js';
export default async function push(options = {}, dependencies = {}) {
    const git = dependencies.git ?? runGit;
    if (options.check !== false) {
        const config = await (dependencies.loadConfig ?? loadUserConfig)();
        if (config.runChecksBeforePush !== false) {
            await (dependencies.checkProject ?? checkProject)();
            // checkProject catches failures and communicates them through exitCode.
            if (process.exitCode && process.exitCode !== '0')
                throw new Error('Project checks failed; push stopped.');
        }
    }
    await git(['add', '.']);
    await commit({ prompt: dependencies.prompt, git });
    await git(['push']);
}
