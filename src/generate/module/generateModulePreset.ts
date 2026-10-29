import prompts from 'prompts';
import { selectContext, selectAggregate } from './repositoryModuleShared.js';
import generateFeaturePreset from './generateFeaturePreset.js';

export default async function generateModulePreset(): Promise<void> {
	const context = await selectContext('Select context for aggregate preset:');
	if (!context) return;
	if (context === 'SharedKernel') throw new Error('SharedKernel is reserved for shared contracts.');
	const aggregate = await selectAggregate(context);
	if (!aggregate) return;
	const { name, route, idType, schemas } = await prompts([
		{ type: 'text', name: 'name', message: 'Module name:', initial: aggregate },
		{
			type: 'text',
			name: 'route',
			message: 'Base request path:',
			initial: '/' + aggregate.toLowerCase(),
			validate: (value: string) => value.startsWith('/') || 'Start the route with /'
		},
		{
			type: 'select',
			name: 'idType',
			message: 'Identifier type:',
			choices: [
				{ title: 'string', value: 'string' },
				{ title: 'number', value: 'number' }
			]
		},
		{ type: 'confirm', name: 'schemas', message: 'Generate schemas for request DTOs?', initial: true }
	]);
	if (!name || !route || !idType || schemas === undefined) return;
	await generateFeaturePreset({ context, aggregate, name, route, idType, schemas });
}
