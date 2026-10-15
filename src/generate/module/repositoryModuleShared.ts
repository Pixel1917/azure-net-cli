import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { selectContext as selectDiskContext, toCamelCase, toPascalCase } from '../../utils/contextUtils.js';
import { updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';

type ContextConfig = { name: string; alias: string };
type TypeLayer = 'Ports' | 'Entities' | 'Enums';
type ResponseKind = 'domain' | 'primitive';
type RepositoryMeta = {
	className: string;
	baseName: string;
	repositoryInterfaceName: string;
	useCasesClassName: string;
	repositoryDependencyName: string;
};
type DomainType = { name: string; layer: TypeLayer; fileName?: string };
type MethodTypeRef = { name: string; layer: TypeLayer };
type MethodResponseRef = { kind: ResponseKind; type: string; layer: TypeLayer | null };
type RepositoryMethod = {
	name: string;
	httpMethod: string;
	route: string;
	response: MethodResponseRef;
	queryType: MethodTypeRef | null;
	bodyType: MethodTypeRef | null;
	pathParamType: string | null;
};
type DatasourceInfo = { name: string; importPath: string };

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'head', 'options', 'patch'];
const MUTATION_METHODS = new Set(['put', 'patch', 'delete']);
const RESERVED_IDENTIFIERS = new Set([
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'import',
	'in',
	'instanceof',
	'new',
	'null',
	'return',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'as',
	'implements',
	'interface',
	'let',
	'package',
	'private',
	'protected',
	'public',
	'static',
	'yield'
]);

const toTypeFileName = (typeName: string): string => String(typeName ?? '').replace(/^I(?=[A-Z])/, '') || 'Type';

export const ensureRepositoryName = (rawName: unknown): string => {
	const normalized = toPascalCase(String(rawName ?? '').trim() || 'Repository');
	return normalized.endsWith('Repository') ? normalized : `${normalized}Repository`;
};

export const getRepositoryMeta = (repositoryName: unknown): RepositoryMeta => {
	const className = ensureRepositoryName(repositoryName);
	const baseName = className.replace(/Repository$/, '') || 'Repository';
	const repositoryInterfaceName = `I${baseName}Repository`;
	const useCasesClassName = `${baseName}UseCases`;
	const repositoryDependencyNameRaw = toCamelCase(baseName || 'repository');
	const repositoryDependencyName = RESERVED_IDENTIFIERS.has(repositoryDependencyNameRaw)
		? `${repositoryDependencyNameRaw}Repository`
		: repositoryDependencyNameRaw;

	return {
		className,
		baseName,
		repositoryInterfaceName,
		useCasesClassName,
		repositoryDependencyName
	};
};

// Compatibility shape for presenter/schema consumers; contexts are discovered on disk.
export const getConfigState = async (): Promise<{ contexts: ContextConfig[]; sharedAlias: string; sharedContextName: string }> => {
	let contexts: ContextConfig[] = [];
	try {
		const entries = await fs.readdir(path.join(process.cwd(), 'src/app/Contexts'), { withFileTypes: true });
		contexts = entries
			.filter((entry) => entry.isDirectory() && /^[A-Z][A-Za-z0-9]*$/.test(entry.name))
			.map((entry) => ({ name: entry.name, alias: '#contexts/' + entry.name }));
	} catch {
		/* A new project may not contain any contexts yet. */
	}
	return { contexts, sharedAlias: '#platform', sharedContextName: 'Platform' };
};

export const selectContext = (message = 'Select context:'): Promise<string | null> => selectDiskContext(message);
export const resolveContextAlias = (_contexts: ContextConfig[], contextName: string): string => '#contexts/' + toPascalCase(contextName);
export const resolveRepositoriesPath = (contextName: string): string =>
	path.join(process.cwd(), 'src/app/Contexts', toPascalCase(contextName), 'Infrastructure/Repositories');
export const resolveDatasourcesPath = (...compatibility: [contextName?: string]): string => {
	void compatibility;
	return path.join(process.cwd(), 'src/app/Platform/Foundation/Datasource');
};
export const resolveSharedDatasourcesPath = async (): Promise<string> => resolveDatasourcesPath();
export const resolveDomainRootPath = (contextName: string, ...compatibility: [domainName?: string]): string => {
	void compatibility;
	return path.join(process.cwd(), 'src/app/Contexts', toPascalCase(contextName), 'Domain');
};
export const resolveUseCasesPath = (contextName: string): string =>
	path.join(process.cwd(), 'src/app/Contexts', toPascalCase(contextName), 'Application/UseCases');

export const getAvailableTsNames = async (targetPath: string): Promise<string[]> => {
	try {
		const files = await fs.readdir(targetPath);
		return files
			.filter((item) => item.endsWith('.ts') && !item.endsWith('.d.ts') && item !== 'index.ts')
			.map((item) => item.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

export const selectDatasource = async (...compatibility: [contextName?: string]): Promise<DatasourceInfo | null> => {
	void compatibility;
	const names = await getAvailableTsNames(await resolveSharedDatasourcesPath());
	if (!names.length) {
		console.error('No datasources found in Platform/Foundation/Datasource. Create a Foundation datasource first.');
		return null;
	}
	const { datasource } = await prompts({
		type: 'select',
		name: 'datasource',
		message: 'Select Foundation datasource:',
		choices: names.map((name) => ({ title: name, value: { name, importPath: '#platform/Foundation/Datasource' } })),
		initial: 0
	});
	return datasource ?? null;
};

// Retained for callers using the old metadata shape; there is no domain-folder selector.
export const selectDomain = async (contextName: string): Promise<string> => toPascalCase(contextName);

export const getDomainTypes = async (contextName: string, domainName?: string): Promise<DomainType[]> => {
	const root = resolveDomainRootPath(contextName, domainName);
	const result: DomainType[] = [];
	const readLayer = async (layer: TypeLayer, relative = ''): Promise<void> => {
		const directory = path.join(root, layer, relative);
		let entries;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await readLayer(layer, path.join(relative, entry.name));
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts') || entry.name === 'index.ts') continue;
			const content = await fs.readFile(path.join(directory, entry.name), 'utf8');
			for (const match of content.matchAll(/export\s+(?:declare\s+)?(?:interface|type|(?:const\s+)?enum|class)\s+([A-Za-z_$][\w$]*)/g)) {
				result.push({ name: match[1]!, layer, fileName: path.join(relative, entry.name.slice(0, -3)).split(path.sep).join('/') });
			}
		}
	};
	for (const layer of ['Ports', 'Entities', 'Enums'] as const) await readLayer(layer);
	return result;
};

// Type expressions are not import specifiers: import their referenced domain symbols only.
const referencedTypes = (expression: string, types: DomainType[]): DomainType[] => {
	const identifiers = new Set(expression.replace(/(['"])(?:\\.|(?!\1).)*?\1/g, '').match(/[A-Za-z_$][\w$]*/g) ?? []);
	return types.filter((type) => identifiers.has(type.name));
};

const isPrimitiveType = (value: unknown): boolean =>
	['string', 'number', 'boolean', 'unknown', 'void', 'null', 'undefined', 'bigint', 'symbol', 'never'].includes(String(value ?? '').trim());

const buildResponseSelection = async (domainTypes: DomainType[]): Promise<MethodResponseRef | null> => {
	const { isPrimitive } = await prompts({
		type: 'confirm',
		name: 'isPrimitive',
		message: 'Is response type primitive?',
		initial: false
	});

	if (isPrimitive) {
		const { primitiveType } = await prompts({
			type: 'text',
			name: 'primitiveType',
			message: 'Primitive response type:',
			validate: (value) => (isPrimitiveType(value) ? true : 'Enter a primitive type such as string, unknown or never')
		});

		return { kind: 'primitive', type: String(primitiveType).trim(), layer: null };
	}

	if (!domainTypes.length) {
		console.error('❌ Domain has no Entities/Ports/Enums types to choose from.');
		return null;
	}

	const { selectedType } = await prompts({
		type: 'select',
		name: 'selectedType',
		message: 'Select response type:',
		choices: domainTypes.map((item) => ({
			title: `${item.name} (${item.layer})`,
			value: item
		})),
		initial: 0
	});

	if (!selectedType) return null;
	return { kind: 'domain', type: selectedType.name, layer: selectedType.layer };
};

const buildDomainRequestTypeSelection = async (question: string, domainTypes: DomainType[]): Promise<MethodTypeRef | null> => {
	if (!domainTypes.length) {
		console.error('❌ Domain has no model/ports types to choose from.');
		return null;
	}

	const { enabled } = await prompts({
		type: 'confirm',
		name: 'enabled',
		message: question,
		initial: false
	});

	if (!enabled) return null;

	const { selectedType } = await prompts({
		type: 'select',
		name: 'selectedType',
		message: 'Select type:',
		choices: domainTypes.map((item) => ({
			title: `${item.name} (${item.layer})`,
			value: item
		})),
		initial: 0
	});

	return selectedType ?? null;
};

const buildPathParamTypeSelection = async (): Promise<string | null> => {
	const { enabled } = await prompts({
		type: 'confirm',
		name: 'enabled',
		message: 'Has path param?',
		initial: false
	});

	if (!enabled) return null;

	const { type } = await prompts({
		type: 'select',
		name: 'type',
		message: 'Path param type:',
		choices: [
			{ title: 'string', value: 'string' },
			{ title: 'number', value: 'number' }
		],
		initial: 0
	});

	return type ?? 'string';
};

export const promptMethodDefinition = async (domainTypes: DomainType[]): Promise<RepositoryMethod | null> => {
	const { methodNameRaw } = await prompts({
		type: 'text',
		name: 'methodNameRaw',
		message: 'Method name:',
		validate: (value) => (String(value ?? '').trim().length > 0 ? true : 'Method name is required')
	});

	const { httpMethod } = await prompts({
		type: 'select',
		name: 'httpMethod',
		message: 'HTTP method:',
		choices: HTTP_METHODS.map((item) => ({ title: item, value: item })),
		initial: 0
	});

	const { routeRaw } = await prompts({
		type: 'text',
		name: 'routeRaw',
		message: 'Request path (e.g. /public-route):',
		initial: '/public-route',
		validate: (value) => {
			const raw = String(value ?? '').trim();
			if (!raw.length) return 'Path is required';
			return raw.startsWith('/') ? true : 'Path must start with "/"';
		}
	});

	const response = await buildResponseSelection(domainTypes);
	if (!response) return null;

	const normalizedMethod = String(httpMethod ?? 'get').toLowerCase();
	let queryType = null;
	let bodyType = null;
	let pathParamType = null;

	if (normalizedMethod === 'get') {
		queryType = await buildDomainRequestTypeSelection('Has query params?', domainTypes);
	} else if (normalizedMethod === 'post') {
		bodyType = await buildDomainRequestTypeSelection('Has request body?', domainTypes);
	} else if (MUTATION_METHODS.has(normalizedMethod)) {
		pathParamType = await buildPathParamTypeSelection();
		bodyType = await buildDomainRequestTypeSelection('Has request body?', domainTypes);
	}

	return {
		name: toCamelCase(String(methodNameRaw ?? '').trim() || 'method'),
		httpMethod: normalizedMethod,
		route: String(routeRaw ?? '/public-route').trim() || '/public-route',
		response,
		queryType,
		bodyType,
		pathParamType
	};
};

const getResponseTypeName = (method: RepositoryMethod): string => method.response.type;

const getMethodParams = (method: RepositoryMethod): string => {
	const params: string[] = [];
	if (method.pathParamType) params.push(`pathParam: ${method.pathParamType}`);
	if (method.queryType) params.push(`request: ${method.queryType.name}`);
	if (method.bodyType) params.push(`request: ${method.bodyType.name}`);
	return params.join(', ');
};

const getRequestMapping = (method: RepositoryMethod): { callbackParams: string; call: string } => {
	const escapedRoute = method.route
		.replace(/\\/g, '\\\\')
		.replace(/`/g, '\\`')
		.replace(/\$\{/g, '\\${')
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n');
	const routeWithPath = method.pathParamType ? `${escapedRoute}/\${pathParam}` : escapedRoute;

	if (method.httpMethod === 'get') {
		if (method.queryType) {
			return {
				callbackParams: '{ http, query }',
				call: `http.get(\`${routeWithPath}\`, { searchParams: query.toSearchParams(request) })`
			};
		}

		return {
			callbackParams: '{ http }',
			call: `http.get(\`${routeWithPath}\`)`
		};
	}

	if (method.httpMethod === 'post') {
		if (method.bodyType) {
			return {
				callbackParams: '{ http }',
				call: `http.post(\`${routeWithPath}\`, { json: request })`
			};
		}

		return {
			callbackParams: '{ http }',
			call: `http.post(\`${routeWithPath}\`)`
		};
	}

	if (method.httpMethod === 'put' || method.httpMethod === 'patch' || method.httpMethod === 'delete') {
		const callMethod = method.httpMethod;
		if (method.bodyType) {
			return {
				callbackParams: '{ http }',
				call: `http.${callMethod}(\`${routeWithPath}\`, { json: request })`
			};
		}

		return {
			callbackParams: '{ http }',
			call: `http.${callMethod}(\`${routeWithPath}\`)`
		};
	}

	return {
		callbackParams: '{ http }',
		call: `http.${method.httpMethod}(\`${routeWithPath}\`)`
	};
};

export const buildRepositoryMethodCode = (method: RepositoryMethod): string => {
	const params = getMethodParams(method);
	const responseType = getResponseTypeName(method);
	const mapping = getRequestMapping(method);

	return `\tpublic async ${method.name}(${params}) {\n\t\treturn this.datasource\n\t\t\t.createRequest<${responseType}>((${mapping.callbackParams}) => ${mapping.call})\n\t\t\t.then((res: { getData(): ${responseType} } | { data: ${responseType} }) => 'getData' in res ? res.getData() : res.data);\n\t}`;
};

export const buildRepositoryContent = ({
	meta,
	contextAlias,
	datasource,
	domainTypes = [],
	methods
}: {
	meta: RepositoryMeta;
	contextAlias: string;
	domainName: string;
	domainTypes?: DomainType[];
	datasource: DatasourceInfo;
	methods: RepositoryMethod[];
}): string => {
	const importLines = [
		`import type { ${meta.repositoryInterfaceName} } from '${contextAlias}/Domain/Ports/${toTypeFileName(meta.repositoryInterfaceName)}';`
	];
	const imported = new Set<string>();
	for (const method of methods) {
		for (const expression of [method.response.type, method.queryType?.name, method.bodyType?.name]) {
			if (!expression) continue;
			for (const type of referencedTypes(expression, domainTypes)) {
				if (imported.has(type.name)) continue;
				imported.add(type.name);
				importLines.push(
					`import type { ${type.name} } from '${contextAlias}/Domain/${type.layer}/${type.fileName ?? toTypeFileName(type.name)}';`
				);
			}
		}
	}
	// Preserve the helper contract for callers that do not supply discovery metadata.
	if (!domainTypes.length) {
		const names = new Set<string>();
		for (const method of methods) {
			if (method.response.kind === 'domain') names.add(method.response.type);
			if (method.queryType) names.add(method.queryType.name);
			if (method.bodyType) names.add(method.bodyType.name);
		}
		if (names.size) importLines.push(`import type { ${[...names].join(', ')} } from '${contextAlias}/Domain';`);
	}
	const methodsCode = methods.map((method) => buildRepositoryMethodCode(method)).join('\n\n');
	const typeImportLine = importLines.join('\n') + '\n';

	return `import { ${datasource.name} } from '${datasource.importPath}';
${typeImportLine}
export class ${meta.className} implements ${meta.repositoryInterfaceName} {
\tconstructor(private readonly datasource: ${datasource.name}) {}

${methodsCode ? `${methodsCode}\n` : ''}
}
`;
};

export const writeRepositoryInterface = async ({
	contextName,
	domainName,
	meta,
	methods
}: {
	contextName: string;
	domainName: string;
	meta: RepositoryMeta;
	methods: RepositoryMethod[];
}): Promise<boolean> => {
	const domainPath = resolveDomainRootPath(contextName, domainName);
	const portsPath = path.join(domainPath, 'Ports');
	await fs.mkdir(portsPath, { recursive: true });

	const types = await getDomainTypes(contextName, domainName);
	const imports: string[] = [];
	const imported = new Set<string>();
	for (const method of methods) {
		for (const expression of [method.response.type, method.queryType?.name, method.bodyType?.name]) {
			if (!expression) continue;
			for (const type of referencedTypes(expression, types)) {
				if (imported.has(type.name) || type.name === meta.repositoryInterfaceName) continue;
				imported.add(type.name);
				const source = type.layer === 'Ports' ? './' : '../' + type.layer + '/';
				imports.push(`import type { ${type.name} } from '${source}${type.fileName}';`);
			}
		}
	}

	const signatures = methods
		.map((method) => {
			const responseType = getResponseTypeName(method);
			const params = getMethodParams(method);
			return `\t${method.name}(${params}): Promise<${responseType}>;`;
		})
		.join('\n');

	const content = `${imports.join('\n')}${imports.length ? '\n\n' : ''}export interface ${meta.repositoryInterfaceName} {\n${signatures ? `${signatures}\n` : ''}}\n`;
	const created = await writeIfNotExists(path.join(portsPath, `${toTypeFileName(meta.repositoryInterfaceName)}.ts`), content);
	if (!created) return false;
	await updateIndexTs(portsPath);
	await ensureDomainScaffold(contextName);
	return true;
};

const parseRepositoryMethodsFromInterface = (content: string): string[] => {
	const methods: string[] = [];
	const regex = /^\s*(\w+)\s*(?:<[^\n]+>)?\s*\(/gm;
	let match;
	while ((match = regex.exec(content)) !== null) {
		const methodName = match[1];
		if (methodName) methods.push(methodName);
	}
	return methods;
};

export const createUseCasesForRepository = async ({
	contextName,
	contextAlias,
	domainName,
	repositoryName
}: {
	contextName: string;
	contextAlias: string;
	domainName: string;
	repositoryName: string;
}): Promise<boolean> => {
	const meta = getRepositoryMeta(repositoryName);
	const type = (await getDomainTypes(contextName, domainName)).find(
		(type) => type.name === meta.repositoryInterfaceName && type.layer === 'Ports'
	);
	const interfaceFileName = type?.fileName ?? toTypeFileName(meta.repositoryInterfaceName);
	const interfacePath = path.join(resolveDomainRootPath(contextName), 'Ports', interfaceFileName + '.ts');

	let interfaceContent = '';
	try {
		interfaceContent = await fs.readFile(interfacePath, 'utf-8');
	} catch {
		console.error(`❌ Repository interface not found: ${interfacePath}`);
		return false;
	}

	const methods = parseRepositoryMethodsFromInterface(interfaceContent);
	const useCasesPath = resolveUseCasesPath(contextName);
	await fs.mkdir(useCasesPath, { recursive: true });

	const declares = methods.map((methodName) => `\tdeclare ${methodName}: ${meta.repositoryInterfaceName}['${methodName}'];`).join('\n');

	const content = `import { ClassMirror } from '@azure-net/kit';
import type { ${meta.repositoryInterfaceName} } from '${contextAlias}/Domain/Ports/${interfaceFileName}';

export class ${meta.useCasesClassName} extends ClassMirror {
\tconstructor(private ${meta.repositoryDependencyName}: ${meta.repositoryInterfaceName}) {
\t\tsuper(${meta.repositoryDependencyName});
\t}

${declares ? `${declares}\n` : ''}
}
`;

	const created = await writeIfNotExists(path.join(useCasesPath, `${meta.useCasesClassName}.ts`), content);
	if (!created) return false;
	await updateIndexTs(useCasesPath);
	return true;
};

export const resolveDomainForRepository = async ({
	contextName,
	contextAlias,
	repositoryName
}: {
	contextName: string;
	contextAlias: string;
	repositoryName: string;
}): Promise<string | null> => {
	const repositoryPath = path.join(resolveRepositoriesPath(contextName), `${ensureRepositoryName(repositoryName)}.ts`);
	try {
		const content = await fs.readFile(repositoryPath, 'utf-8');
		return content.includes(`${contextAlias}/Domain`) ? toPascalCase(contextName) : null;
	} catch {
		return null;
	}
};

export const promptMethodsBatch = async (domainTypes: DomainType[], count: number): Promise<RepositoryMethod[] | null> => {
	const methods: RepositoryMethod[] = [];
	for (let index = 0; index < count; index += 1) {
		console.log(`\n🧩 Method ${index + 1} of ${count}`);
		const method = await promptMethodDefinition(domainTypes);
		if (!method) return null;
		if (method.name === 'constructor' || methods.some((item) => item.name === method.name))
			throw new Error('Duplicate or reserved method name: ' + method.name);
		methods.push(method);
	}
	return methods;
};

export const ensureDomainScaffold = async (contextName: string): Promise<void> => {
	const root = resolveDomainRootPath(contextName);
	for (const layer of ['Entities', 'Ports', 'Enums']) {
		const directory = path.join(root, layer);
		await fs.mkdir(directory, { recursive: true });
		await updateIndexTs(directory);
	}
	await writeIfNotExists(path.join(root, 'index.ts'), "export * from './Entities';\nexport * from './Ports';\nexport * from './Enums';\n");
};

export const printApplicationProviderWiring = (contextName: string, repositoryName: string, datasourceName: string): void => {
	const meta = getRepositoryMeta(repositoryName);
	const alias = resolveContextAlias([], contextName);
	console.log('\nManually wire #platform/Foundation/DI/ApplicationProvider.ts before generating the presenter.');
	console.log(`import { ${datasourceName} } from '#platform/Foundation/Datasource';
import { ${meta.className} } from '${alias}/Infrastructure/Repositories';
import { ${meta.useCasesClassName} } from '${alias}/Application/UseCases';

// Merge into the existing ApplicationProvider configuration.
register: () => {
 const repository = () => new ${meta.className}(new ${datasourceName}({ /* http, query */ }));
 return {
  ${meta.useCasesClassName}: () => new ${meta.useCasesClassName}(repository()),
  // Optional: expose the repository as a lazy factory too.
  // ${meta.className}: repository,
 };
}`);
};
