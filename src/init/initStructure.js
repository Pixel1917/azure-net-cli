import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';
import initAliases, { normalizeContexts } from './initAliases.js';

const ROOT = path.join(process.cwd(), 'src');
const APP_ROOT = path.join(ROOT, 'app');

const CONTEXT_DIRS = [
	'ui',
	'layers',
	'layers/domain',
	'layers/application',
	'layers/application/providers',
	'layers/application/use-cases',
	'layers/infrastructure',
	'layers/infrastructure/providers',
	'layers/infrastructure/http',
	'layers/infrastructure/http/repositories',
	'layers/presentation'
];

const SHARED_DIRS = ['core'];

const ensureDir = async (dirPath) => {
	try {
		await fs.mkdir(dirPath, { recursive: true });
	} catch (error) {
		console.warn(`⚠️ Failed to create directory: ${dirPath}`, error);
	}
};

const ensureFile = async (filePath, content) => {
	try {
		await fs.access(filePath);
		return;
	} catch {
		// File is missing
	}

	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, 'utf-8');
	} catch (error) {
		console.warn(`⚠️ Failed to create file: ${filePath}`, error);
	}
};

const toPascalCase = (value) =>
	value
		.split(/[-_\s]+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');

const createInfrastructureProvider = (contextName) => `import { createBoundaryProvider } from '@azure-net/kit';

export const ${contextName}InfrastructureProvider = createBoundaryProvider('${contextName}InfrastructureProvider', {
\tregister: () => ({})
});
`;

const createApplicationProvider = (contextName) => `import { createBoundaryProvider } from '@azure-net/kit';
import { ${contextName}InfrastructureProvider } from '../../infrastructure/providers';

export const ${contextName}ApplicationProvider = createBoundaryProvider('${contextName}ApplicationProvider', {
\tdependsOn: { ${contextName}InfrastructureProvider },
\tregister: () => ({})
});
`;

const printContextsError = () => {
	console.error('❌ Cannot generate folders structure: `contexts` is missing or empty in azure-net.config.ts/js');
	console.error('Add contexts first, for example:');
	console.error('export default {');
	console.error("\tcontexts: ['web', 'admin']");
	console.error('\t// or');
	console.error("\t// contexts: [{ name: 'web', alias: '$web' }, { name: 'admin', alias: '$admin' }]");
	console.error('};');
};

const ensureContextStructure = async (context) => {
	const contextRoot = path.join(APP_ROOT, context.name);
	for (const dir of CONTEXT_DIRS) {
		await ensureDir(path.join(contextRoot, dir));
	}

	const contextName = toPascalCase(context.name);
	const infraProviderPath = path.join(contextRoot, 'layers', 'infrastructure', 'providers', 'InfrastructureProvider.ts');
	const infraProviderIndex = path.join(contextRoot, 'layers', 'infrastructure', 'providers', 'index.ts');
	const appProviderPath = path.join(contextRoot, 'layers', 'application', 'providers', 'ApplicationProvider.ts');
	const appProviderIndex = path.join(contextRoot, 'layers', 'application', 'providers', 'index.ts');
	const repositoriesIndex = path.join(contextRoot, 'layers', 'infrastructure', 'http', 'repositories', 'index.ts');
	const useCasesIndex = path.join(contextRoot, 'layers', 'application', 'use-cases', 'index.ts');

	await ensureFile(infraProviderPath, createInfrastructureProvider(contextName));
	await ensureFile(infraProviderIndex, `export * from './InfrastructureProvider';\n`);
	await ensureFile(appProviderPath, createApplicationProvider(contextName));
	await ensureFile(appProviderIndex, `export * from './ApplicationProvider';\n`);
	await ensureFile(repositoriesIndex, '');
	await ensureFile(useCasesIndex, '');
};

export default async function initStructure() {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);

	if (!contexts.length) {
		printContextsError();
		return;
	}

	for (const sharedDir of SHARED_DIRS) {
		await ensureDir(path.join(ROOT, sharedDir));
	}

	for (const context of contexts) {
		await ensureContextStructure(context);
	}

	await initAliases();
	console.log('✅ Folders structure initialized');
}
