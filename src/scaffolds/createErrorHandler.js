import path from 'node:path';
import { getBootstrapPath } from '../utils/architecture.js';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
export default async function createErrorHandler() {
	const root = path.join(getBootstrapPath(), 'Handlers');
	await writeIfNotExists(
		path.join(root, 'ErrorHandler.ts'),
		`import type { AppServerErrorContext } from '@azure-net/kit';

export const ErrorHandler = ({ error }: AppServerErrorContext) => {
	// Report server errors here. HTTP retry belongs to ApiDatasource.
 void error;
};
`
	);
	await updateIndexTs(root);
	console.log(
		"In bootstrap/index.ts, import { ErrorHandler } from '#bootstrap/Handlers' and call app.useServerError(ErrorHandler). Existing Bootstrap preserved."
	);
}
