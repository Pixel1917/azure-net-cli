import path from 'node:path';
import prompts from 'prompts';
import { getBootstrapPath, normalizePascalName } from '../utils/architecture.js';
import { writeIfNotExists, updateIndexTs, appendBarrelExports } from '../utils/fileUtils.js';
export default async function createMiddleware() {
    const { name } = await prompts({ type: 'text', name: 'name', message: 'Middleware name:', initial: 'Example' });
    if (name === undefined)
        return;
    const normalized = normalizePascalName(String(name));
    const root = path.join(getBootstrapPath(), 'Pipelines/Middlewares', normalized);
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
    console.log(`In src/bootstrap/index.ts, import the middleware classes from '#bootstrap/Pipelines/Middlewares' and managers from '@azure-net/kit'.
const client = new ClientMiddlewareManager([Client${normalized}Middleware]);
const server = new ServerMiddlewareManager([Server${normalized}Middleware]);
// import { beforeNavigate } from '$app/navigation';
// app.useClient(() => { beforeNavigate(navigation => client.execute(navigation)); })
// app.useServer(async ({ event, resolve }) => { await server.execute(); return resolve(event); })
Existing bootstrap preserved. Add these classes to existing managers if they are already configured.`);
}
