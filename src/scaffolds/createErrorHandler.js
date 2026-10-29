import path from 'node:path';
import { getPlatformPath } from '../utils/architecture.js';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
export default async function createErrorHandler() {
    const root = path.join(getPlatformPath(), 'Bootstrap/Handlers');
    await writeIfNotExists(path.join(root, 'ErrorHandler.ts'), `import type { AppAzureNetKitErrorContext } from '@azure-net/kit';

export const ErrorHandler = ({ error }: AppAzureNetKitErrorContext) => {
	return error.toPlainObject();
};
`);
    await updateIndexTs(root);
    console.log("In Bootstrap/Bootstrap.ts, import { ErrorHandler } from '#platform/Bootstrap/Handlers' and call app.useAzureNetKitError(ErrorHandler). Existing Bootstrap preserved.");
}
