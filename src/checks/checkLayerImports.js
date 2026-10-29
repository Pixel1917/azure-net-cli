import { checkDependencies } from './architecture.js';
export default async function checkLayerImports() {
    await checkDependencies('Layer imports', (source, target) => {
        if (source[0] !== 'Contexts')
            return null;
        if (target[0] === 'Presentation')
            return 'Contexts cannot import Presentation';
        if (target[0] !== 'Contexts')
            return null;
        const from = source[source[1] === 'SharedKernel' ? 2 : 3];
        const to = target[target[1] === 'SharedKernel' ? 2 : 3];
        if ((from === 'Domain' && (to === 'Application' || to === 'Infrastructure')) || (from === 'Infrastructure' && to === 'Application'))
            return `${from} cannot import ${to}`;
        return null;
    });
}
