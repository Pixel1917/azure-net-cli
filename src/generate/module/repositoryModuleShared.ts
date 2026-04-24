import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { normalizeContexts } from '../../init/initAliases.js';
import { toCamelCase, toPascalCase } from '../../utils/contextUtils.js';
import { updateIndexTs } from '../../utils/fileUtils.js';

type ContextConfig = { name: string; alias: string };
type TypeLayer = 'ports' | 'model';
type ResponseKind = 'domain' | 'primitive';
type RepositoryMeta = {
	className: string;
	baseName: string;
	repositoryInterfaceName: string;
	useCasesClassName: string;
	repositoryDependencyName: string;
};
type DomainType = { name: string; layer: TypeLayer };
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

const normalizeAlias = (value: unknown, fallback: string): string => {
	const raw = String(value ?? '').trim();
	if (!raw.length) return fallback;
	return raw.startsWith('$') ? raw : `$${raw}`;
};

const toTypeFileName = (typeName: string): string => String(typeName ?? '').replace(/^I/, '') || 'Type';

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

export const getConfigState = async (): Promise<{ contexts: ContextConfig[]; coreAlias: string }> => {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);
	const coreAlias = normalizeAlias(config.coreAlias, '$core');
	return { contexts, coreAlias };
};

export const selectContext = async (message = 'Select context:'): Promise<string | null> => {
	const { contexts } = await getConfigState();
	if (!contexts.length) {
		console.error('❌ Cannot continue: `contexts` is missing or empty in azure-net.config.ts/js');
		return null;
	}

	const { context } = await prompts({
		type: 'select',
		name: 'context',
		message,
		choices: contexts.map((item) => ({ title: item.name, value: item.name })),
		initial: 0
	});

	return context ? String(context) : null;
};

export const resolveContextAlias = (contexts: ContextConfig[], contextName: string): string => {
	const found = contexts.find((item) => item.name === contextName);
	if (!found) return `$${contextName}`;
	return normalizeAlias(found.alias, `$${contextName}`);
};

export const resolveRepositoriesPath = (contextName: string): string =>
	path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'infrastructure', 'http', 'repositories');

export const resolveDatasourcesPath = (contextName: string): string =>
	path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'infrastructure', 'http', 'datasources');

export const resolveCoreDatasourcesPath = (): string => path.join(process.cwd(), 'src', 'core', 'datasource');

export const resolveDomainRootPath = (contextName: string, domainName: string): string =>
	path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'domain', domainName);

export const resolveUseCasesPath = (contextName: string): string =>
	path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'application', 'use-cases');

export const getAvailableTsNames = async (targetPath: string): Promise<string[]> => {
	try {
		const files = await fs.readdir(targetPath);
		return files.filter((item) => item.endsWith('.ts') && item !== 'index.ts').map((item) => item.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

export const selectDatasource = async (contextName: string): Promise<DatasourceInfo | null> => {
	const { contexts, coreAlias } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);
	const coreDatasources = await getAvailableTsNames(resolveCoreDatasourcesPath());
	const contextDatasources = await getAvailableTsNames(resolveDatasourcesPath(contextName));

	const choices: Array<{ title: string; value: DatasourceInfo }> = [];
	for (const datasource of coreDatasources) {
		choices.push({
			title: `${datasource} (core)`,
			value: { name: datasource, importPath: `${coreAlias}/datasource` }
		});
	}

	for (const datasource of contextDatasources) {
		choices.push({
			title: `${datasource} (${contextName})`,
			value: { name: datasource, importPath: `${contextAlias}/layers/infrastructure/http/datasources` }
		});
	}

	if (!choices.length) {
		console.error(`❌ No datasources found in core or context "${contextName}".`);
		return null;
	}

	const { datasource } = await prompts({
		type: 'select',
		name: 'datasource',
		message: 'Select datasource:',
		choices,
		initial: 0
	});

	return datasource ?? null;
};

export const selectDomain = async (contextName: string): Promise<string | null> => {
	const domainPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'domain');
	try {
		const items = await fs.readdir(domainPath, { withFileTypes: true });
		const domains = items.filter((item) => item.isDirectory()).map((item) => item.name);
		if (!domains.length) {
			console.error(`❌ No domain folders found in ${domainPath}`);
			return null;
		}

		const { domain } = await prompts({
			type: 'select',
			name: 'domain',
			message: 'Select domain:',
			choices: domains.map((item) => ({ title: item, value: item })),
			initial: 0
		});

		return domain ? String(domain) : null;
	} catch {
		console.error(`❌ Domain path not found: ${domainPath}`);
		return null;
	}
};

const extractInterfaceName = (content: string, fallback: string): string => {
	const match = content.match(/export\s+interface\s+([A-Za-z0-9_]+)/);
	return match?.[1] ?? fallback;
};

export const getDomainTypes = async (contextName: string, domainName: string): Promise<DomainType[]> => {
	const root = resolveDomainRootPath(contextName, domainName);
	const result: DomainType[] = [];
	const readLayer = async (layer: TypeLayer): Promise<void> => {
		const layerPath = path.join(root, layer);
		try {
			const files = await fs.readdir(layerPath);
			for (const fileName of files) {
				if (!fileName.endsWith('.ts') || fileName === 'index.ts') continue;
				const absolute = path.join(layerPath, fileName);
				const content = await fs.readFile(absolute, 'utf-8');
				const fallback = fileName.replace(/\.ts$/, '');
				const interfaceName = extractInterfaceName(content, fallback);
				result.push({ name: interfaceName, layer });
			}
		} catch {
			// ignore
		}
	};

	await readLayer('ports');
	await readLayer('model');
	return result;
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
			validate: (value) => (String(value ?? '').trim().length > 0 ? true : 'Type is required')
		});

		return { kind: 'primitive', type: String(primitiveType).trim(), layer: null };
	}

	if (!domainTypes.length) {
		console.error('❌ Domain has no model/ports types to choose from.');
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
	const routeWithPath = method.pathParamType ? `${method.route}/\${pathParam}` : method.route;

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

	return `\tpublic async ${method.name}(${params}) {\n\t\treturn this.datasource\n\t\t\t.createRequest<${responseType}>((${mapping.callbackParams}) => ${mapping.call})\n\t\t\t.then((res) => res.getData());\n\t}`;
};

export const buildRepositoryContent = ({
	meta,
	contextAlias,
	domainName,
	datasource,
	methods
}: {
	meta: RepositoryMeta;
	contextAlias: string;
	domainName: string;
	datasource: DatasourceInfo;
	methods: RepositoryMethod[];
}): string => {
	const typeImports = new Set([meta.repositoryInterfaceName]);
	for (const method of methods) {
		if (!isPrimitiveType(method.response.type)) typeImports.add(method.response.type);
		if (method.queryType) typeImports.add(method.queryType.name);
		if (method.bodyType) typeImports.add(method.bodyType.name);
	}

	const methodsCode = methods.map((method) => buildRepositoryMethodCode(method)).join('\n\n');
	const typeImportLine = typeImports.size
		? `import type { ${Array.from(typeImports).join(', ')} } from '${contextAlias}/layers/domain/${domainName}';\n`
		: '';

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
}): Promise<void> => {
	const domainPath = resolveDomainRootPath(contextName, domainName);
	const portsPath = path.join(domainPath, 'ports');
	await fs.mkdir(portsPath, { recursive: true });

	const portsImports = new Set<string>();
	const modelImports = new Set<string>();

	for (const method of methods) {
		const allTypes: MethodTypeRef[] = [];
		if (!isPrimitiveType(method.response.type) && method.response.layer) {
			allTypes.push({ name: method.response.type, layer: method.response.layer });
		}
		if (method.queryType) allTypes.push(method.queryType);
		if (method.bodyType) allTypes.push(method.bodyType);

		for (const typeEntry of allTypes) {
			if (typeEntry.layer === 'ports') portsImports.add(typeEntry.name);
			if (typeEntry.layer === 'model') modelImports.add(typeEntry.name);
		}
	}

	const imports: string[] = [];
	for (const name of Array.from(portsImports)) {
		imports.push(`import type { ${name} } from './${toTypeFileName(name)}';`);
	}
	for (const name of Array.from(modelImports)) {
		imports.push(`import type { ${name} } from '../model/${toTypeFileName(name)}';`);
	}

	const signatures = methods
		.map((method) => {
			const responseType = getResponseTypeName(method);
			const params = getMethodParams(method);
			return `\t${method.name}(${params}): Promise<${responseType}>;`;
		})
		.join('\n');

	const content = `${imports.join('\n')}${imports.length ? '\n\n' : ''}export interface ${meta.repositoryInterfaceName} {\n${signatures ? `${signatures}\n` : ''}}\n`;
	await fs.writeFile(path.join(portsPath, `${meta.repositoryInterfaceName}.ts`), content, 'utf-8');
	await updateIndexTs(portsPath);
};

const parseRepositoryFileForDomain = (content: string, contextAlias: string): string | null => {
	const escapedAlias = contextAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(`from\\s+['"]${escapedAlias}/layers/domain/([^'"]+)['"]`);
	const match = content.match(regex);
	return match?.[1] ?? null;
};

const parseRepositoryMethodsFromInterface = (content: string): string[] => {
	const methods: string[] = [];
	const regex = /(\w+)\(([^)]*)\)\s*:\s*Promise<([^>]+)>;/g;
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
	const interfacePath = path.join(resolveDomainRootPath(contextName, domainName), 'ports', `${meta.repositoryInterfaceName}.ts`);

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
import type { ${meta.repositoryInterfaceName} } from '${contextAlias}/layers/domain/${domainName}';

export class ${meta.useCasesClassName} extends ClassMirror {
\tconstructor(private ${meta.repositoryDependencyName}: ${meta.repositoryInterfaceName}) {
\t\tsuper(${meta.repositoryDependencyName});
\t}

${declares ? `${declares}\n` : ''}
}
`;

	await fs.writeFile(path.join(useCasesPath, `${meta.useCasesClassName}.ts`), content, 'utf-8');
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
		return parseRepositoryFileForDomain(content, contextAlias);
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
		methods.push(method);
	}
	return methods;
};
