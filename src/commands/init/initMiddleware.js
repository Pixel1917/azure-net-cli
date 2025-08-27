import { writeIfNotExists, updateCoreIndex } from '../../utils/fileUtils.js';
import path from 'path';

const middlewarePath = path.join(process.cwd(), 'src/app/core/middleware/MiddlewareManager.ts');

const middlewareTemplate = `import { createMiddlewareManager } from '@azure-net/kit';

export const { clientMiddleware, serverMiddleware } = createMiddlewareManager([]);`;

export default async function initMiddleware() {
    await writeIfNotExists(middlewarePath, middlewareTemplate);
    await writeIfNotExists(
        path.join(process.cwd(), 'src/app/core/middleware/index.ts'),
        `export * from './MiddlewareManager';`
    );

    // Update core index
    await updateCoreIndex();

    console.log('✅ Middleware initialized');
}