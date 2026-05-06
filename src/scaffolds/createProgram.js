import path from 'node:path';
import { writeIfNotExists } from '../utils/fileUtils.js';

const createProgramTemplate = () => `import { createApp } from '@azure-net/kit';

export const { register, App } = createApp((app) => app);
`;

export default async function createProgram() {
	const programPath = path.join(process.cwd(), 'src', 'program.ts');
	const created = await writeIfNotExists(programPath, createProgramTemplate());

	if (!created) {
		console.log('⚠️ Program already exists. Nothing was overwritten.');
		return;
	}

	console.log(`✅ Program created: ${programPath}`);
}
