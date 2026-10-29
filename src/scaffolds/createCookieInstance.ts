import path from 'node:path';
import { getPlatformPath } from '../utils/architecture.js';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';

export default async function createCookieInstance(): Promise<void> {
	const root = path.join(getPlatformPath(), 'Foundation/Cookie');
	await writeIfNotExists(
		path.join(root, 'Instance.ts'),
		`import { UniversalCookie } from '@azure-net/kit';

export const CookieInstance = UniversalCookie.createInstance({ path: '/', httpOnly: false });
`
	);
	await updateIndexTs(root);
}
