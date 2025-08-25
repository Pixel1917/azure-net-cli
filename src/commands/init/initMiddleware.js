import { writeIfNotExists, injectIntoFile } from '../../utils/fileUtils.js';
import path from 'path';

const middlewarePath = path.join(process.cwd(), 'src/app/core/Middleware/MiddlewareManager.ts');
const hooksServerPath = path.join(process.cwd(), 'src/hooks.server.ts');
const layoutPath = path.join(process.cwd(), 'src/routes/+layout.svelte');

const middlewareTemplate = `import { createMiddlewareManager } from '@azure-net/kit';

export const { clientMiddleware, serverMiddleware } = createMiddlewareManager([]);`;

export default async function initMiddleware() {
    await writeIfNotExists(middlewarePath, middlewareTemplate);
    await writeIfNotExists(
        path.join(process.cwd(), 'src/app/core/Middleware/index.ts'),
        `export * from './MiddlewareManager';`
    );

    // Add to hooks.server.ts
    await injectIntoFile(
        hooksServerPath,
        'import',
        `import { serverMiddleware } from '$core';`,
        'before'
    );

    await injectIntoFile(
        hooksServerPath,
        'async ({ edgesEvent, serialize }) => {',
        '\t\t\tawait serverMiddleware();',
        'after'
    );

    // Add to +layout.svelte
    await injectIntoFile(
        layoutPath,
        '<script',
        `\timport { clientMiddleware } from '$core';\n\tclientMiddleware();`,
        'after'
    );

    console.log('✅ Middleware initialized');
}