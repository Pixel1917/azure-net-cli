import path from 'node:path';
import prompts from 'prompts';
import { getPlatformPath, normalizePascalName } from '../utils/architecture.js';
import { writeIfNotExists, updateIndexTs, appendBarrelExports } from '../utils/fileUtils.js';
export default async function createMiddleware() {
    const { name } = await prompts({ type: 'text', name: 'name', message: 'Middleware name:', initial: 'Example' });
    if (name === undefined)
        return;
    const normalized = normalizePascalName(String(name));
    const root = path.join(getPlatformPath(), 'Bootstrap/Pipelines/Middlewares', normalized);
    for (const side of ['Client', 'Server']) {
        await writeIfNotExists(path.join(root, `${side}.ts`), `import type { I${side}Middleware, ${side}MiddlewareContext } from '@azure-net/kit';

export class ${side}${normalized}Middleware implements I${side}Middleware {
	 execute({ next }: ${side}MiddlewareContext): ${side === 'Client' ? 'undefined' : 'void'} {
		return next();
	}
}
`);
    }
    await updateIndexTs(root);
    await appendBarrelExports(path.join(root, '../index.ts'), [`./${normalized}`]);
    console.log(`In Bootstrap/Bootstrap.ts, import Client${normalized}Middleware and Server${normalized}Middleware from '#platform/Bootstrap/Pipelines/Middlewares'. Register each using useMiddlewares in app.useClient/app.useServer; await server middleware and return resolve(event). Existing Bootstrap preserved.`);
}
