import { writeIfNotExists, injectIntoFile } from '../../utils/fileUtils.js';
import path from 'path';

const middlewarePath = path.join(process.cwd(), 'src/app/core/Middleware/MiddlewareManager.ts');
const hooksServerPath = path.join(process.cwd(), 'src/hooks.server.ts');
const layoutPath = path.join(process.cwd(), 'src/routes/+layout.svelte');

const middlewareTemplate = `import { createMiddlewareManager, type IMiddleware } from '@azure-net/kit';

const AuthMiddleware: IMiddleware = async ({ next, page, event, isServer, cookies }) => {
\tconst user = isServer ? event?.locals?.user : page?.data?.user;
\tif (isServer && !user && cookies.get('token') && event) {
\t\t// Add auth logic here
\t}
\tnext();
};

const GuardMiddleware: IMiddleware = async ({ next, page, event, isServer, to }) => {
\tconst user = isServer ? event?.locals?.user : page?.data?.user;
\tif (!user && !to.pathname.startsWith('/login')) {
\t\tnext('/login');
\t}
\tif (user && to.pathname.startsWith('/login')) {
\t\tnext('/');
\t}
\tnext();
};

export const { clientMiddleware, serverMiddleware } = createMiddlewareManager([AuthMiddleware, GuardMiddleware]);`;

export default async function initMiddleware() {
    await writeIfNotExists(middlewarePath, middlewareTemplate);

    // Add to hooks.server.ts
    await injectIntoFile(
        hooksServerPath,
        `import { serverMiddleware } from '$core/Middleware/index.js';`,
        'import',
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
        `\timport { clientMiddleware } from '$core/Middleware/index.js';\n\tclientMiddleware();`,
        'after'
    );

    console.log('✅ Middleware initialized');
}