import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toKebabCase, toPascalCase } from '../../utils/contextUtils.js';
import { updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';
import generatePresenter from './generatePresenter.js';
import {
	buildRepositoryContent,
	createUseCasesForRepository,
	getAvailableTsNames,
	getConfigState,
	getRepositoryMeta,
	resolveContextAlias,
	resolveCoreDatasourcesPath,
	resolveDatasourcesPath,
	resolveDomainRootPath,
	resolveRepositoriesPath,
	selectContext,
	writeRepositoryInterface
} from './repositoryModuleShared.js';

type DatasourceDescriptor = { name: string; importPath: string };

type PresetMethod = {
	name: string;
	httpMethod: 'get' | 'post' | 'put' | 'delete';
	route: string;
	response: { kind: 'domain' | 'primitive'; type: string; layer: 'model' | 'ports' | null };
	queryType: { name: string; layer: 'ports' | 'model' } | null;
	bodyType: { name: string; layer: 'ports' | 'model' } | null;
	pathParamType: 'string' | 'number' | null;
};

const toInterfaceFileName = (interfaceName: string): string => `${String(interfaceName ?? '').replace(/^I/, '') || 'Type'}.ts`;

const createInterfaceContent = (interfaceName: string): string => `export interface ${interfaceName} {
\t[key: string]: unknown;
}
`;

const writeDomainIndexes = async (domainPath: string, modelPath: string, portsPath: string): Promise<void> => {
	await updateIndexTs(modelPath);
	await updateIndexTs(portsPath);
	await fs.writeFile(path.join(domainPath, 'index.ts'), `export * from './model';\nexport * from './ports';\n`, 'utf-8');
};

const ensureDomainScaffold = async ({
	contextName,
	entityNamePascal,
	domainName
}: {
	contextName: string;
	entityNamePascal: string;
	domainName: string;
}): Promise<{ domainPath: string; modelPath: string; portsPath: string }> => {
	const domainPath = resolveDomainRootPath(contextName, domainName);
	const modelPath = path.join(domainPath, 'model');
	const portsPath = path.join(domainPath, 'ports');

	await fs.mkdir(modelPath, { recursive: true });
	await fs.mkdir(portsPath, { recursive: true });

	const modelInterfaces = [`I${entityNamePascal}`];
	const portInterfaces = [
		`I${entityNamePascal}CreateRequest`,
		`I${entityNamePascal}UpdateRequest`,
		`I${entityNamePascal}CollectionResponse`,
		`I${entityNamePascal}CollectionQuery`
	];

	for (const interfaceName of modelInterfaces) {
		const filePath = path.join(modelPath, toInterfaceFileName(interfaceName));
		await writeIfNotExists(filePath, createInterfaceContent(interfaceName));
	}

	for (const interfaceName of portInterfaces) {
		const filePath = path.join(portsPath, toInterfaceFileName(interfaceName));
		await writeIfNotExists(filePath, createInterfaceContent(interfaceName));
	}

	await writeDomainIndexes(domainPath, modelPath, portsPath);
	return { domainPath, modelPath, portsPath };
};

const resolveDatasourceForPreset = async (contextName: string): Promise<DatasourceDescriptor | null> => {
	const { contexts, coreAlias } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);

	const coreDatasources = await getAvailableTsNames(resolveCoreDatasourcesPath());
	const contextDatasources = await getAvailableTsNames(resolveDatasourcesPath(contextName));

	if (coreDatasources.includes('ApiDatasource')) {
		return { name: 'ApiDatasource', importPath: `${coreAlias}/datasource` };
	}

	if (contextDatasources.includes('ApiDatasource')) {
		return { name: 'ApiDatasource', importPath: `${contextAlias}/layers/infrastructure/http/datasources` };
	}

	if (coreDatasources.length) {
		return { name: coreDatasources[0] as string, importPath: `${coreAlias}/datasource` };
	}

	if (contextDatasources.length) {
		return { name: contextDatasources[0] as string, importPath: `${contextAlias}/layers/infrastructure/http/datasources` };
	}

	return null;
};

const buildPresetMethods = ({
	entityNamePascal,
	route,
	pathParamType
}: {
	entityNamePascal: string;
	route: string;
	pathParamType: 'string' | 'number';
}): PresetMethod[] => [
	{
		name: 'collection',
		httpMethod: 'get',
		route,
		response: { kind: 'domain', type: `I${entityNamePascal}CollectionResponse`, layer: 'ports' },
		queryType: { name: `I${entityNamePascal}CollectionQuery`, layer: 'ports' },
		bodyType: null,
		pathParamType: null
	},
	{
		name: 'resource',
		httpMethod: 'get',
		route,
		response: { kind: 'domain', type: `I${entityNamePascal}`, layer: 'model' },
		queryType: null,
		bodyType: null,
		pathParamType
	},
	{
		name: 'create',
		httpMethod: 'post',
		route,
		response: { kind: 'domain', type: `I${entityNamePascal}`, layer: 'model' },
		queryType: null,
		bodyType: { name: `I${entityNamePascal}CreateRequest`, layer: 'ports' },
		pathParamType: null
	},
	{
		name: 'update',
		httpMethod: 'put',
		route,
		response: { kind: 'domain', type: `I${entityNamePascal}`, layer: 'model' },
		queryType: null,
		bodyType: { name: `I${entityNamePascal}UpdateRequest`, layer: 'ports' },
		pathParamType
	},
	{
		name: 'destroy',
		httpMethod: 'delete',
		route,
		response: { kind: 'primitive', type: 'never', layer: null },
		queryType: null,
		bodyType: null,
		pathParamType
	}
];

const findProviderFile = async (
	contextName: string,
	layerName: 'application' | 'infrastructure',
	preferredFileName: string
): Promise<string> => {
	const providersPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', layerName, 'providers');
	const preferredPath = path.join(providersPath, preferredFileName);
	try {
		await fs.access(preferredPath);
		return preferredPath;
	} catch {
		try {
			const files = await fs.readdir(providersPath);
			const firstTs = files.find((item) => item.endsWith('.ts') && item !== 'index.ts');
			return firstTs ? path.join(providersPath, firstTs) : preferredPath;
		} catch {
			return preferredPath;
		}
	}
};

const parseProviderConstName = async (providerPath: string, fallbackName: string): Promise<string> => {
	try {
		const content = await fs.readFile(providerPath, 'utf-8');
		const match = content.match(/export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*createBoundaryProvider/);
		return match?.[1] ?? fallbackName;
	} catch {
		return fallbackName;
	}
};

export default async function generateModulePreset(): Promise<void> {
	const contextName = await selectContext('Select context for preset module:');
	if (!contextName) {
		process.exitCode = 1;
		return;
	}

	const { entityNameRaw } = await prompts({
		type: 'text',
		name: 'entityNameRaw',
		message: 'Module name:',
		validate: (value: string) => (String(value ?? '').trim().length > 0 ? true : 'Module name is required')
	});

	const { routeRaw } = await prompts({
		type: 'text',
		name: 'routeRaw',
		message: 'Base request path (e.g. /users):',
		initial: '/resource',
		validate: (value: string) => {
			const route = String(value ?? '').trim();
			if (!route.length) return 'Path is required';
			return route.startsWith('/') ? true : 'Path must start with "/"';
		}
	});

	const { pathParamType } = await prompts({
		type: 'select',
		name: 'pathParamType',
		message: 'Path param type:',
		choices: [
			{ title: 'string', value: 'string' },
			{ title: 'number', value: 'number' }
		],
		initial: 0
	});

	const entityNamePascal = toPascalCase(String(entityNameRaw ?? '').trim());
	if (!entityNamePascal) {
		console.error('❌ Invalid module name.');
		process.exitCode = 1;
		return;
	}

	const route = String(routeRaw ?? '').trim();
	if (!route) {
		console.error('❌ Invalid route.');
		process.exitCode = 1;
		return;
	}

	const resolvedPathParamType: 'string' | 'number' = pathParamType === 'number' ? 'number' : 'string';
	const domainName = toKebabCase(entityNamePascal);

	await ensureDomainScaffold({ contextName, entityNamePascal, domainName });

	const datasource = await resolveDatasourceForPreset(contextName);
	if (!datasource) {
		console.error('❌ No datasource found in core or selected context. Create datasource first.');
		process.exitCode = 1;
		return;
	}

	const methods = buildPresetMethods({
		entityNamePascal,
		route,
		pathParamType: resolvedPathParamType
	});

	const repositoryClassName = `${entityNamePascal}Repository`;
	const meta = getRepositoryMeta(repositoryClassName);
	const { contexts } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);

	await writeRepositoryInterface({
		contextName,
		domainName,
		meta,
		methods
	});

	const repositoryContent = buildRepositoryContent({
		meta,
		contextAlias,
		domainName,
		datasource,
		methods
	});

	const repositoriesPath = resolveRepositoriesPath(contextName);
	await fs.mkdir(repositoriesPath, { recursive: true });
	const repositoryPath = path.join(repositoriesPath, `${meta.className}.ts`);
	const createdRepository = await writeIfNotExists(repositoryPath, repositoryContent);
	await updateIndexTs(repositoriesPath);

	if (!createdRepository) {
		console.error(`❌ Repository "${meta.className}" already exists. Preset flow stopped.`);
		process.exitCode = 1;
		return;
	}

	await createUseCasesForRepository({
		contextName,
		contextAlias,
		domainName,
		repositoryName: meta.className
	});

	const infrastructureProviderPath = await findProviderFile(contextName, 'infrastructure', 'InfrastructureProvider.ts');
	const applicationProviderPath = await findProviderFile(contextName, 'application', 'ApplicationProvider.ts');
	const infrastructureProviderName = await parseProviderConstName(infrastructureProviderPath, 'InfrastructureProvider');

	console.log('\n⚠️ Manual provider registration is required before presenter generation.');
	console.log(`Infrastructure provider file: ${infrastructureProviderPath}`);
	console.log(`Application provider file: ${applicationProviderPath}`);
	console.log('\nSuggested register snippets:');
	console.log(`- Infrastructure register: ${meta.className}: () => new ${meta.className}(/* datasource */),`);
	console.log(
		`- Application register: ${meta.useCasesClassName}: () => new ${meta.useCasesClassName}(${infrastructureProviderName}().${meta.className}),`
	);

	const { readyAnswer } = await prompts({
		type: 'text',
		name: 'readyAnswer',
		message: 'Type "y" when provider wiring is done:'
	});

	const normalizedReadyAnswer = String(readyAnswer ?? '')
		.trim()
		.toLowerCase();
	if (normalizedReadyAnswer !== 'y') {
		console.log('ℹ️ Preset module flow paused. Complete provider wiring and run `azure-net generate presenter`.');
		return;
	}

	await generatePresenter({
		contextName,
		useCasesName: meta.useCasesClassName
	});
}
