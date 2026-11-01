import { checkDependencies } from './architecture.js';

export default async function checkLayerBoundaries(): Promise<void> {
	await checkDependencies('Layer boundaries', (source, target) => {
		if (source[0] === 'ApplicationCore' && ['Contexts', 'Presentation'].includes(target[0] ?? ''))
			return 'ApplicationCore cannot import Contexts or Presentation';
		if (target[0] === '..' && target[1] === 'bootstrap') {
			const allowed =
				source[0] === '..' && (source[1] === 'bootstrap' || source[1] === 'routes' || (source[1] === 'program.ts' && source.length === 2));
			if (!allowed) return 'bootstrap can only be imported by src/routes, src/program.ts or src/bootstrap';
		}
		if (source[0] === 'Contexts') {
			if (target[0] === 'Presentation') return 'Contexts cannot import Presentation';
			if (target[0] === 'Contexts' && !target[1])
				return 'Contexts cannot import the global Contexts barrel; import their own context or SharedKernel';
			if (
				target[0] === 'Contexts' &&
				source[1] !== target[1] &&
				target[1] &&
				(source[1] === 'SharedKernel' || target[1] !== 'SharedKernel')
			) {
				return `Context "${source[1]}" cannot import context "${target[1]}"; only SharedKernel is shared`;
			}
		}
		if (source[0] === 'Presentation' && target[0] === 'Presentation') {
			const from = source[1];
			const to = target[1];
			if (from && to && source.length > 2 && from !== to && to !== 'Shared') {
				return `Presentation workspace "${from}" cannot import workspace "${to}"`;
			}
		}
		return null;
	});
}
