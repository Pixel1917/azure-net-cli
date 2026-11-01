import path from 'node:path';
import fs from 'node:fs/promises';
import prompts from 'prompts';
import { selectWorkspace, selectScope, normalizePascalName } from '../../utils/architecture.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';
export default async function generateStore() {
    const workspace = await selectWorkspace();
    if (!workspace)
        return;
    const scope = await selectScope(workspace);
    if (!scope)
        return;
    const answer = await prompts({
        type: 'text',
        name: 'name',
        message: 'State class name:',
        validate: (value) => {
            try {
                normalizePascalName(value);
                return true;
            }
            catch (error) {
                return error.message;
            }
        }
    });
    if (!answer.name)
        return;
    const name = normalizePascalName(String(answer.name));
    const directory = path.join(workspace.path, 'Scopes', scope, 'Stores');
    const created = await writeIfNotExists(path.join(directory, `${name}.svelte.ts`), `export class ${name} {
 value = $state<string | null>(null);
 set(value: string | null) { this.value = value; }
 reset() { this.value = null; }
}
`);
    if (!created)
        return;
    const indexFile = path.join(directory, 'index.ts');
    let index = '';
    try {
        index = await fs.readFile(indexFile, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    index += `\nimport { RegisterProvider as Register${name} } from '@azure-net/kit/delivery';
import { ${name} } from './${name}.svelte';
export const use${name} = Register${name}(() => new ${name}(), { lifecycle: 'singleton' });
`;
    await fs.writeFile(indexFile, index);
}
