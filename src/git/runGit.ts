import { spawn } from 'node:child_process';

export type GitRunner = (args: string[]) => Promise<void>;

export const runGit: GitRunner = (args) =>
	new Promise((resolve, reject) => {
		const child = spawn('git', args, { stdio: 'inherit', shell: false });
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`git ${args[0]} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
		});
	});
