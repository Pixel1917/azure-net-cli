import path from 'node:path';
import { writeIfNotExists } from '../utils/fileUtils.js';
import createBootstrap, { type BootstrapOptions } from './createBootstrap.js';

export default async function createProgram(options: BootstrapOptions = {}): Promise<void> {
	await createBootstrap(options);
	await writeIfNotExists(
		path.join(process.cwd(), 'src/program.ts'),
		`import { AppBootstrap } from '#platform/Bootstrap/Bootstrap';

export const { register } = AppBootstrap();
`
	);
}
