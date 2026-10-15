import { checkDependencies } from './architecture.js';

export default async function checkLayerImports(): Promise<void> {
	await checkDependencies('Layer imports', (source, target) => {
		if (source[0] !== 'Contexts') return null;
		if (target[0] === 'Presentation') return 'Contexts cannot import Presentation';
		if (target[0] !== 'Contexts') return null;
		const from = source[2];
		const to = target[2];
		if ((from === 'Domain' && (to === 'Application' || to === 'Infrastructure')) || (from === 'Infrastructure' && to === 'Application'))
			return `${from} cannot import ${to}`;
		return null;
	});
}
