import prompts from 'prompts';
import path from 'path';
import {
	selectContext,
	getContextPath,
	toPascalCase,
	getAvailableFiles,
	getApplicationProviderServices,
	toKebabCase
} from '../../utils/contextUtils.js';
import { updateIndexTs, writeIfNotExists, updateCoreIndex } from '../../utils/fileUtils.js';

const presenterWithCoreTemplate = `import { {{presenterFactory}} } from '$core/presenters';
import { ApplicationProvider } from '\${{context}}/application';

export const {{name}}Presenter = {{presenterFactory}}('{{name}}Presenter', ({ createAsyncResource, createAsyncAction }) => {
\tconst { {{serviceName}} } = ApplicationProvider();
\t
\t// Add your presenter methods here
\t
\treturn {};
});`;

const presenterWithoutCoreTemplate = `import { createPresenter } from '@azure-net/kit';
import { ApplicationProvider } from '\${{context}}/application';

export const {{name}}Presenter = createPresenter('{{name}}Presenter', () => {
\tconst { {{serviceName}} } = ApplicationProvider();
\t
\t// Add your presenter methods here
\t
\treturn {};
});`;

export default async function generateModulePresenter() {
	const context = await selectContext('Select context for module presenter:');

	// Get available services from ApplicationProvider
	const services = await getApplicationProviderServices(context);

	if (services.length === 0) {
		console.error('❌ No services found in ApplicationProvider. Add services manually first.');
		return;
	}

	const { service } = await prompts({
		type: 'select',
		name: 'service',
		message: 'Select service for presenter:',
		choices: services.map((s) => ({ title: s, value: s }))
	});

	const { moduleName } = await prompts({
		type: 'text',
		name: 'moduleName',
		message: 'Module name for presenter (will create folder in delivery):'
	});

	// Extract entity name from service name
	const pascalName = toPascalCase(moduleName);
	const entityLower = toKebabCase(pascalName);

	// Get presenter factory
	const corePresenters = await getAvailableFiles(path.join(process.cwd(), 'src/core/presenters'));

	const { presenterType } = await prompts({
		type: 'select',
		name: 'presenterType',
		message: 'Select presenter factory:',
		choices: [
			{ title: 'Use createPresenter from package', value: 'package' },
			...corePresenters.map((p) => ({ title: `Use ${p} from core`, value: p }))
		]
	});

	const contextPath = getContextPath(context);
	const deliveryModulePath = path.join(contextPath, 'delivery', entityLower);

	console.log('\n🚀 Generating module presenter...\n');

	// Create Presenter
	const presenterTemplate = presenterType === 'package' ? presenterWithoutCoreTemplate : presenterWithCoreTemplate;

	const presenterFactory = presenterType === 'package' ? 'createPresenter' : presenterType;

	await writeIfNotExists(
		path.join(deliveryModulePath, `${pascalName}Presenter.ts`),
		presenterTemplate
			.replace(/{{name}}/g, pascalName)
			.replace(/{{context}}/g, context)
			.replace(/{{serviceName}}/g, service)
			.replace(/{{presenterFactory}}/g, presenterFactory)
	);

	// Create module index
	await writeIfNotExists(path.join(deliveryModulePath, 'index.ts'), `export * from './${pascalName}Presenter';`);

	// Update core index
	await updateCoreIndex();

	console.log(`✅ Module presenter for ${pascalName} created successfully!`);
	console.log(`\n💡 Remember to add presenter methods using the ${service}.`);
}
