import fs from 'node:fs/promises';
import path from 'node:path';
import { writeIfNotExists } from '../utils/fileUtils.js';

const createMiddlewareManagerTemplate = () => `import { createMiddlewareManager } from '@azure-net/kit';

export const { clientMiddleware, serverMiddleware, executeMiddlewares } = createMiddlewareManager([]);
`;

export default async function createCoreMiddleware() {
	const middlewareManagerPath = path.join(process.cwd(), 'src', 'core', 'middleware-manager');
	const middlewaresPath = path.join(middlewareManagerPath, 'middlewares');
	const middlewareManagerFile = path.join(middlewareManagerPath, 'MiddlewareManager.ts');
	const indexFile = path.join(middlewareManagerPath, 'index.ts');

	await fs.mkdir(middlewaresPath, { recursive: true });

	const createdManager = await writeIfNotExists(middlewareManagerFile, createMiddlewareManagerTemplate());
	const createdIndex = await writeIfNotExists(indexFile, `export * from './MiddlewareManager';\n`);

	if (!createdManager && !createdIndex) {
		console.log('⚠️ Core middleware manager already exists. Nothing was overwritten.');
		return;
	}

	console.log(`✅ Core middleware manager created: ${middlewareManagerPath}`);
}
