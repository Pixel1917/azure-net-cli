import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUserConfig } from '../utils/loadConfig.js';
import initAliases, { normalizeContexts } from './initAliases.js';
import { getSharedEssentialsPath } from '../utils/sharedFoundation.js';

type ContextConfig = { name: string; alias: string };

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

const SHARED_ESSENTIALS_DIRS = [
	'',
	'foundation',
	'foundation/constructs',
	'foundation/constructs/datasource',
	'foundation/constructs/presenter',
	'foundation/constructs/provider',
	'foundation/constructs/response',
	'foundation/constructs/schema',
	'foundation/constructs/schema/custom-rules',
	'localization',
	'pipelines'
];

const ensureDir = async (dirPath: string): Promise<void> => {
	try {
		await fs.mkdir(dirPath, { recursive: true });
	} catch (error) {
		console.warn(`⚠️ Failed to create directory: ${dirPath}`, error);
	}
};

const ensureFile = async (filePath: string, content: string): Promise<void> => {
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

const toPascalCase = (value: string): string =>
	value
		.split(/[-_\s]+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');

const createInfrastructureProvider = (contextName: string) => `import { createBoundaryProvider } from '@azure-net/kit';

export const ${contextName}InfrastructureProvider = createBoundaryProvider('${contextName}InfrastructureProvider', {
\tregister: () => ({})
});
`;

const createApplicationProvider = (contextName: string) => `import { createBoundaryProvider } from '@azure-net/kit';
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

const printSharedAliasError = () => {
	console.error('❌ Cannot generate folders structure: `sharedAlias` is missing in azure-net.config.ts/js');
	console.error('Add shared context and alias first, for example:');
	console.error('export default {');
	console.error("\tsharedAlias: '$shared-kernel',");
	console.error("\tcontexts: [{ name: 'shared-kernel', alias: '$shared-kernel' }, 'public']");
	console.error('};');
};

const ensureSharedEssentialsStructure = async (contexts: ContextConfig[], sharedAlias: string): Promise<boolean> => {
	const normalizedSharedAlias = sharedAlias.startsWith('$') ? sharedAlias : `$${sharedAlias}`;
	const sharedContext = contexts.find((context) => context.alias === normalizedSharedAlias);

	if (!sharedContext) {
		console.error(`❌ sharedAlias "${normalizedSharedAlias}" does not point to any configured context.`);
		return false;
	}

	const essentialsRoot = getSharedEssentialsPath(sharedContext.name);
	for (const dir of SHARED_ESSENTIALS_DIRS) {
		await ensureDir(path.join(essentialsRoot, dir));
	}

	return true;
};

const ensureContextStructure = async (context: ContextConfig): Promise<void> => {
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

export default async function initStructure(): Promise<void> {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts) as ContextConfig[];

	if (!contexts.length) {
		printContextsError();
		return;
	}

	const sharedAlias = String(config.sharedAlias ?? '').trim();
	if (!sharedAlias.length) {
		printSharedAliasError();
		process.exitCode = 1;
		return;
	}

	for (const context of contexts) {
		await ensureContextStructure(context);
	}

	const sharedCreated = await ensureSharedEssentialsStructure(contexts, sharedAlias);
	if (!sharedCreated) {
		process.exitCode = 1;
		return;
	}

	await initAliases();
	console.log('✅ Folders structure initialized');
}
