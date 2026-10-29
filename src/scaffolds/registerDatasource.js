import path from 'node:path';
import { getPlatformPath } from '../utils/architecture.js';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
export async function registerDatasource(className) {
    const root = path.join(getPlatformPath(), 'Foundation/Provider');
    const created = await writeIfNotExists(path.join(root, 'HttpProvider.ts'), `import { CreateServiceContainer } from '@azure-net/kit';
import { ${className} } from '#platform/Foundation/Datasource';

export const HttpProvider = CreateServiceContainer('HttpProvider', {
	register: () => ({
		${className}: () => new ${className}({ httpOptions: { prefixUrl: '' } })
	})
});
`);
    await updateIndexTs(root);
    if (!created)
        console.log(`Existing HttpProvider preserved. Register ${className}: () => new ${className}({ httpOptions: { prefixUrl: '' } }) in HttpProvider.register.`);
}
