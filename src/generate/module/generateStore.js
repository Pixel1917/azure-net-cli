import path from 'node:path';
import prompts from 'prompts';
import { selectWorkspace, selectScope, normalizePascalName } from '../../utils/architecture.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
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
    const directory = path.join(workspace.path, 'Scopes', scope);
    await writeIfNotExists(path.join(directory, `${name}.svelte.ts`), `import { RegisterProvider } from '@azure-net/kit/delivery';

export class ${name} {
 value = $state<string | null>(null);
 set = (value: string | null) => { this.value = value; };
 reset = () => { this.value = null; };
}

export const use${name} = RegisterProvider(() => new ${name}(), 'singleton');
`);
    await updateIndexTs(directory);
}
