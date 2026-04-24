import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { normalizeContexts } from '../../init/initAliases.js';
import { toCamelCase, toKebabCase, toPascalCase } from '../../utils/contextUtils.js';
import { updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';

type ContextConfig = { name: string; alias: string };
type DomainLayer = 'ports' | 'model';
type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'head' | 'options' | 'patch';
type RepositoryMeta = {
	className: string;
	baseName: string;
	domainName: string;
	repositoryInterfaceName: string;
	useCasesClassName: string;
	repositoryDependencyName: string;
};
type DatasourceInfo = { name: string; source: 'core' | 'context'; importPath: string };
type RepositoryMethod = {
	name: string;
	httpMethod: HttpMethod;
	responseType: string;
	responseLayer: DomainLayer;
	route: string;
	requestType: string | null;
	requestLayer: DomainLayer | null;
};

const toHttpMethod = (value: unknown): HttpMethod => {
	const normalized = String(value ?? '').toLowerCase();
	if (
		normalized === 'get' ||
		normalized === 'post' ||
		normalized === 'put' ||
		normalized === 'delete' ||
		normalized === 'head' ||
		normalized === 'options' ||
		normalized === 'patch'
	) {
		return normalized;
	}
	return 'get';
};

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'head', 'options', 'patch'];

const normalizeAlias = (value: unknown, fallback: string): string => {
	const raw = String(value ?? '').trim();
	if (!raw.length) return fallback;
	return raw.startsWith('$') ? raw : `$${raw}`;
};

export const ensureRepositoryName = (rawName: unknown): string => {
	const normalized = toPascalCase(String(rawName ?? '').trim() || 'Repository');
	return normalized.endsWith('Repository') ? normalized : `${normalized}Repository`;
};

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

const toSafeIdentifier = (value: string): string => {
	const normalized = toCamelCase(value || 'repository');
	if (!normalized.length) return 'repository';
	if (RESERVED_IDENTIFIERS.has(normalized)) return `${normalized}Repository`;
	return normalized;
};

export const getRepositoryMeta = (repositoryClassName: unknown): RepositoryMeta => {
	const className = ensureRepositoryName(repositoryClassName);
	const baseName = className.replace(/Repository$/, '') || 'Repository';
	const domainName = toKebabCase(baseName);
	const repositoryInterfaceName = `I${baseName}Repository`;
	const useCasesClassName = `${baseName}UseCases`;
	const repositoryDependencyName = toSafeIdentifier(baseName || 'repository');

	return {
		className,
		baseName,
		domainName,
		repositoryInterfaceName,
		useCasesClassName,
		repositoryDependencyName
	};
};

export const getConfigState = async (): Promise<{ contexts: ContextConfig[]; coreAlias: string }> => {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);
	const coreAlias = normalizeAlias(config.coreAlias, '$core');

	return {
		contexts,
		coreAlias
	};
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
			value: {
				name: datasource,
				source: 'core',
				importPath: `${coreAlias}/datasource`
			}
		});
	}

	for (const datasource of contextDatasources) {
		choices.push({
			title: `${datasource} (${contextName})`,
			value: {
				name: datasource,
				source: 'context',
				importPath: `${contextAlias}/layers/infrastructure/http/datasources`
			}
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

const updateDomainIndex = async (domainRootPath: string): Promise<void> => {
	const exports: string[] = [];

	try {
		await fs.access(path.join(domainRootPath, 'ports'));
		exports.push(`export * from './ports';`);
	} catch {
		// ignore
	}

	try {
		await fs.access(path.join(domainRootPath, 'model'));
		exports.push(`export * from './model';`);
	} catch {
		// ignore
	}

	const content = exports.length ? `${exports.join('\n')}\n` : '';
	await fs.mkdir(domainRootPath, { recursive: true });
	await fs.writeFile(path.join(domainRootPath, 'index.ts'), content, 'utf-8');
};

const normalizeTypeName = (rawTypeName: unknown): string => {
	const normalized = toPascalCase(String(rawTypeName ?? '').trim());
	return normalized || 'IType';
};

export const ensureDomainType = async ({
	contextName,
	domainName,
	typeName,
	layer
}: {
	contextName: string;
	domainName: string;
	typeName: unknown;
	layer: DomainLayer;
}): Promise<{ interfaceName: string; layer: DomainLayer }> => {
	const interfaceName = normalizeTypeName(typeName);
	const domainRootPath = resolveDomainRootPath(contextName, domainName);
	const preferredLayer = layer === 'model' ? 'model' : 'ports';
	const portsTypePath = path.join(domainRootPath, 'ports', `${interfaceName}.ts`);
	const modelTypePath = path.join(domainRootPath, 'model', `${interfaceName}.ts`);

	try {
		await fs.access(portsTypePath);
		return { interfaceName, layer: 'ports' };
	} catch {
		// ignore
	}

	try {
		await fs.access(modelTypePath);
		return { interfaceName, layer: 'model' };
	} catch {
		// ignore
	}

	const layerPath = path.join(domainRootPath, preferredLayer);
	const filePath = path.join(layerPath, `${interfaceName}.ts`);

	await fs.mkdir(layerPath, { recursive: true });
	await writeIfNotExists(filePath, `export interface ${interfaceName} {\n\t[key: string]: unknown;\n}\n`);
	await updateIndexTs(layerPath);
	await updateDomainIndex(domainRootPath);

	return { interfaceName, layer: preferredLayer };
};

export const ensureRepositoryInterfaceFile = async ({
	contextName,
	meta,
	methods
}: {
	contextName: string;
	meta: RepositoryMeta;
	methods: RepositoryMethod[];
}): Promise<void> => {
	const domainRootPath = resolveDomainRootPath(contextName, meta.domainName);
	const portsPath = path.join(domainRootPath, 'ports');
	await fs.mkdir(portsPath, { recursive: true });

	const resolveTypeLayer = async (typeName: string): Promise<DomainLayer | null> => {
		const portsTypePath = path.join(domainRootPath, 'ports', `${typeName}.ts`);
		const modelTypePath = path.join(domainRootPath, 'model', `${typeName}.ts`);

		try {
			await fs.access(portsTypePath);
			return 'ports';
		} catch {
			// ignore
		}

		try {
			await fs.access(modelTypePath);
			return 'model';
		} catch {
			// ignore
		}

		return null;
	};

	const importsByLayer = { ports: new Set<string>(), model: new Set<string>() };
	for (const method of methods) {
		const relatedTypes = [method.responseType, method.requestType].filter((item): item is string => Boolean(item));
		for (const typeName of relatedTypes) {
			const typeLayer = await resolveTypeLayer(typeName);
			if (typeLayer === 'ports') importsByLayer.ports.add(typeName);
			if (typeLayer === 'model') importsByLayer.model.add(typeName);
		}
	}

	const importLines: string[] = [];
	for (const typeName of Array.from(importsByLayer.ports)) {
		importLines.push(`import type { ${typeName} } from './${typeName}.js';`);
	}
	for (const typeName of Array.from(importsByLayer.model)) {
		importLines.push(`import type { ${typeName} } from '../model/${typeName}.js';`);
	}

	const signatures = methods
		.map((method) => {
			const arg = method.requestType ? `data: ${method.requestType}` : '';
			return `\t${method.name}(${arg}): Promise<${method.responseType}>;`;
		})
		.join('\n');

	const content = `${importLines.join('\n')}${importLines.length ? '\n\n' : ''}export interface ${meta.repositoryInterfaceName} {\n${signatures ? `${signatures}\n` : ''}}\n`;
	await fs.writeFile(path.join(portsPath, `${meta.repositoryInterfaceName}.ts`), content, 'utf-8');
	await updateIndexTs(portsPath);
	await updateDomainIndex(domainRootPath);
};

const buildHttpCall = (method: RepositoryMethod): string => {
	const httpMethod = method.httpMethod.toLowerCase();
	const route = method.route || '/public-route';
	if (!method.requestType) {
		return `http.${httpMethod}('${route}')`;
	}

	if (httpMethod === 'get' || httpMethod === 'head' || httpMethod === 'options') {
		return `http.${httpMethod}('${route}', { searchParams: query.toSearchParams(data) })`;
	}

	return `http.${httpMethod}('${route}', { json: data })`;
};

export const buildRepositoryMethodCode = (method: RepositoryMethod): string => {
	const arg = method.requestType ? `data: ${method.requestType}` : '';
	const call = buildHttpCall(method);

	let getInCallback = `http`;
	const httpMethod = String(method.httpMethod ?? '').toLowerCase();
	if (httpMethod === 'get' || httpMethod === 'head' || httpMethod === 'options') {
		getInCallback = `http, query`;
	}

	return `\tpublic async ${method.name}(${arg}) {\n\t\treturn this.datasource\n\t\t\t.createRequest<${method.responseType}>(({ ${getInCallback} }) => ${call})\n\t\t\t.then((res) => res.get());\n\t}`;
};

export const buildRepositoryContent = ({
	meta,
	contextAlias,
	datasourceImportPath,
	datasourceName,
	methods
}: {
	meta: RepositoryMeta;
	contextAlias: string;
	datasourceImportPath: string;
	datasourceName: string;
	methods: RepositoryMethod[];
}): string => {
	const importedTypes = new Set([meta.repositoryInterfaceName]);
	for (const method of methods) {
		importedTypes.add(method.responseType);
		if (method.requestType) importedTypes.add(method.requestType);
	}

	const methodsCode = methods.map((method) => buildRepositoryMethodCode(method)).join('\n\n');

	return `import { ${datasourceName} } from '${datasourceImportPath}';
import type { ${Array.from(importedTypes).join(', ')} } from '${contextAlias}/layers/domain/${meta.domainName}';

export class ${meta.className} implements ${meta.repositoryInterfaceName} {
\tconstructor(private readonly datasource: ${datasourceName}) {}

${methodsCode ? `${methodsCode}\n` : ''}
}
`;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const upsertImport = (content: string, source: string, names: Array<string | null>) => {
	const uniqueNames = Array.from(new Set(names)).filter((item): item is string => Boolean(item));
	if (!uniqueNames.length) return content;

	const importRegex = new RegExp(`import\\s+(type\\s+)?\\{([^}]+)\\}\\s*from\\s*['"]${escapeRegExp(source)}['"];?`);
	const match = content.match(importRegex);

	if (match) {
		const existing = (match[2] ?? '')
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
		const merged = Array.from(new Set([...existing, ...uniqueNames]));
		return content.replace(importRegex, `import type { ${merged.join(', ')} } from '${source}';`);
	}

	const lines = content.split('\n');
	let insertIndex = 0;
	while (insertIndex < lines.length && (lines[insertIndex] ?? '').startsWith('import ')) {
		insertIndex += 1;
	}

	lines.splice(insertIndex, 0, `import type { ${uniqueNames.join(', ')} } from '${source}';`);
	return lines.join('\n');
};

export const appendRepositoryMethod = async ({
	repositoryPath,
	method,
	contextAlias,
	domainName
}: {
	repositoryPath: string;
	method: RepositoryMethod;
	contextAlias: string;
	domainName: string;
}): Promise<boolean> => {
	let content = await fs.readFile(repositoryPath, 'utf-8');
	const methodExistsRegex = new RegExp(`\\bpublic\\s+async\\s+${escapeRegExp(method.name)}\\s*\\(`);
	if (methodExistsRegex.test(content)) {
		console.warn(`⚠️ Method "${method.name}" already exists in repository, skipped.`);
		return false;
	}

	content = upsertImport(content, `${contextAlias}/layers/domain/${domainName}`, [method.responseType, method.requestType]);

	const methodCode = buildRepositoryMethodCode(method);
	const classEnd = content.lastIndexOf('\n}');
	if (classEnd === -1) {
		throw new Error(`Repository class end was not found in ${repositoryPath}`);
	}

	content = `${content.slice(0, classEnd)}\n\n${methodCode}\n${content.slice(classEnd)}`;
	await fs.writeFile(repositoryPath, content, 'utf-8');
	return true;
};

export const parseRepositoryMethods = (content: string): RepositoryMethod[] => {
	const methods: RepositoryMethod[] = [];
	const regex =
		/public\s+async\s+(\w+)\(([^)]*)\)\s*\{[\s\S]*?\.createRequest<([^>]+)>\(\(\{ http \}\) =>\s*http\.(get|post|put|delete|head|options|patch)\(/g;

	let match;
	while ((match = regex.exec(content)) !== null) {
		const name = match[1];
		const params = match[2] ?? '';
		const responseType = (match[3] ?? '').trim();
		const httpMethod = toHttpMethod(match[4]);
		const requestTypeMatch = params.match(/:\s*([A-Za-z0-9_]+)/);
		const requestType = requestTypeMatch?.[1] ?? null;

		methods.push({
			name: name ?? 'method',
			httpMethod,
			responseType,
			responseLayer: 'ports',
			requestType,
			requestLayer: requestType ? 'ports' : null,
			route: '/public-route'
		});
	}

	return methods;
};

export const ensureUseCasesFile = async ({
	contextName,
	contextAlias,
	meta
}: {
	contextName: string;
	contextAlias: string;
	meta: RepositoryMeta;
}): Promise<boolean> => {
	const repositoryInterfacePath = path.join(
		resolveDomainRootPath(contextName, meta.domainName),
		'ports',
		`${meta.repositoryInterfaceName}.ts`
	);

	let interfaceContent = '';
	try {
		interfaceContent = await fs.readFile(repositoryInterfacePath, 'utf-8');
	} catch {
		console.error(`❌ Repository interface not found: ${repositoryInterfacePath}`);
		return false;
	}

	const methods: string[] = [];
	const methodRegex = /(\w+)\(([^)]*)\)\s*:\s*Promise<[^>]+>;/g;
	let methodMatch;
	while ((methodMatch = methodRegex.exec(interfaceContent)) !== null) {
		const methodName = methodMatch[1];
		if (methodName) methods.push(methodName);
	}

	const declares = methods.map((methodName) => `\tdeclare ${methodName}: ${meta.repositoryInterfaceName}['${methodName}'];`).join('\n');
	const useCasesPath = resolveUseCasesPath(contextName);
	await fs.mkdir(useCasesPath, { recursive: true });

	const content = `import { ClassMirror } from '@azure-net/kit';
import type { ${meta.repositoryInterfaceName} } from '${contextAlias}/layers/domain/${meta.domainName}';

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

export const promptMethodDefinition = async (): Promise<RepositoryMethod> => {
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
		choices: HTTP_METHODS.map((value) => ({ title: value, value })),
		initial: 0
	});

	const { responseTypeRaw } = await prompts({
		type: 'text',
		name: 'responseTypeRaw',
		message: 'Response type name:',
		validate: (value) => (String(value ?? '').trim().length > 0 ? true : 'Response type is required')
	});

	const { responseLayer } = await prompts({
		type: 'select',
		name: 'responseLayer',
		message: 'Where to place response type?',
		choices: [
			{ title: 'ports', value: 'ports' },
			{ title: 'model', value: 'model' }
		],
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

	const { hasRequest } = await prompts({
		type: 'confirm',
		name: 'hasRequest',
		message: 'Has request payload type?',
		initial: false
	});

	let requestType = null;
	let requestLayer = null;

	if (hasRequest) {
		const { requestTypeRaw } = await prompts({
			type: 'text',
			name: 'requestTypeRaw',
			message: 'Request type name:',
			validate: (value) => (String(value ?? '').trim().length > 0 ? true : 'Request type is required')
		});

		const layerResult = await prompts({
			type: 'select',
			name: 'requestLayer',
			message: 'Where to place request type?',
			choices: [
				{ title: 'ports', value: 'ports' },
				{ title: 'model', value: 'model' }
			],
			initial: 0
		});

		requestType = normalizeTypeName(requestTypeRaw);
		requestLayer = layerResult.requestLayer ?? 'ports';
	}

	return {
		name: toCamelCase(String(methodNameRaw ?? '').trim() || 'method'),
		httpMethod: toHttpMethod(httpMethod),
		responseType: normalizeTypeName(responseTypeRaw),
		responseLayer: responseLayer ?? 'ports',
		route: String(routeRaw ?? '/public-route').trim() || '/public-route',
		requestType,
		requestLayer
	};
};
