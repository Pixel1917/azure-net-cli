import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import ts from 'typescript';
import { getAggregatePath, getPlatformPath, selectAggregate, discoverContexts, ensureContextStructure } from '../../utils/architecture.js';
export { selectAggregate };
import { toCamelCase, toPascalCase } from '../../utils/contextUtils.js';
import { updateIndexTs, writeIfNotExists } from '../../utils/fileUtils.js';

type ContextConfig = { name: string; alias: string };
type TypeLayer = 'Ports' | 'Resources' | 'DTO' | 'Entities' | 'Enums';
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
export type RepositoryMethod = {
	name: string;
	httpMethod: string;
	route: string;
	response: MethodResponseRef;
	queryType: MethodTypeRef | null;
	bodyType: MethodTypeRef | null;
	pathParamType: string | null;
};
export type DatasourceInfo = { name: string; importPath: string; interfaceName?: string };

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

export const selectContext = async (message = 'Select context:'): Promise<string | null> => {
	await ensureContextStructure('SharedKernel');
	const names = (await discoverContexts()).filter((name) => name !== 'SharedKernel');
	const { context } = await prompts({
		type: 'select',
		name: 'context',
		message,
		choices: [...names.map((name) => ({ title: name, value: name })), { title: 'Create new context', value: '__create__' }]
	});
	if (!context) return null;
	if (context === 'SharedKernel') throw new Error('SharedKernel is not an aggregate context.');
	if (context !== '__create__') return toPascalCase(context);
	const { name } = await prompts({
		type: 'text',
		name: 'name',
		message: 'Context name:',
		validate: (value: string) => {
			try {
				return toPascalCase(value) && toPascalCase(value) !== 'SharedKernel' ? true : 'Choose a non-shared context name';
			} catch (error) {
				return (error as Error).message;
			}
		}
	});
	if (!name) return null;
	if (toPascalCase(name) === 'SharedKernel') throw new Error('SharedKernel is not an aggregate context.');
	return ensureContextStructure(name);
};
export const resolveContextAlias = (_contexts: ContextConfig[], contextName: string): string => '#contexts/' + toPascalCase(contextName);
export const resolveRepositoriesPath = (contextName: string, aggregate = contextName): string =>
	path.join(getAggregatePath(contextName, aggregate), 'Infrastructure/Repositories');
export const resolveDatasourcesPath = (...compatibility: [contextName?: string]): string => {
	void compatibility;
	return path.join(getPlatformPath(), 'Foundation/Datasource');
};
export const resolveSharedDatasourcesPath = async (): Promise<string> => resolveDatasourcesPath();
export const resolveDomainRootPath = (contextName: string, aggregate = contextName): string =>
	path.join(getAggregatePath(contextName, aggregate), 'Domain');
export const resolveUseCasesPath = (contextName: string, aggregate = contextName): string =>
	path.join(getAggregatePath(contextName, aggregate), 'Application/UseCases');

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

export const resolveDatasource = async (name: string): Promise<DatasourceInfo> => {
	const normalized = toPascalCase(name);
	const file = path.join(resolveDatasourcesPath(), normalized + '.ts');
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		throw new Error('Datasource file not found: ' + file + '. Create it with foundation datasource.');
	}
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const interfaceName = 'I' + normalized;
	const exported = (node: ts.ClassDeclaration | ts.InterfaceDeclaration) =>
		node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
	if (
		!source.statements.some((n) => ts.isInterfaceDeclaration(n) && n.name.text === interfaceName && exported(n)) ||
		!source.statements.some((n) => ts.isClassDeclaration(n) && n.name?.text === normalized && exported(n))
	)
		throw new Error('Datasource must export class ' + normalized + ' and interface ' + interfaceName + ': ' + file);
	return { name: normalized, interfaceName, importPath: '#platform/Foundation/Datasource/' + normalized };
};

export const selectDatasource = async (...compatibility: [contextName?: string]): Promise<DatasourceInfo | null> => {
	void compatibility;
	const names = (await getAvailableTsNames(await resolveSharedDatasourcesPath())).filter((name) => name.endsWith('Datasource'));
	if (!names.length) {
		console.error('No datasources found in platform/Foundation/Datasource. Create a Foundation datasource first.');
		return null;
	}
	const { datasource } = await prompts({
		type: 'select',
		name: 'datasource',
		message: 'Select Foundation datasource:',
		choices: names.map((name) => ({ title: name, value: name })),
		initial: 0
	});
	if (!datasource) return null;
	// Older programmatic callers may supply the selection descriptor.
	return resolveDatasource(typeof datasource === 'string' ? datasource : datasource.name);
};

// Retained for callers using the old metadata shape; there is no domain-folder selector.
export const selectDomain = selectAggregate;

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
	for (const layer of ['Ports', 'Resources', 'DTO', 'Enums'] as const) await readLayer(layer);
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
	if (method.queryType) params.push(`${method.bodyType ? 'queryParams' : 'request'}: ${method.queryType.name}`);
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

	const options: string[] = [];
	if (method.queryType) options.push(`searchParams: query.toSearchParams(${method.bodyType ? 'queryParams' : 'request'})`);
	if (method.bodyType) options.push('json: request');
	return {
		callbackParams: method.queryType ? '{ http, query }' : '{ http }',
		call: `http.${method.httpMethod}(\`${routeWithPath}\`${options.length ? ', { ' + options.join(', ') + ' }' : ''})`
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
	domainName,
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
	const aggregateAlias = contextAlias + '/' + domainName;
	const importLines = [
		`import type { ${meta.repositoryInterfaceName} } from '${aggregateAlias}/Domain/Ports/${toTypeFileName(meta.repositoryInterfaceName)}';`
	];
	const imported = new Set<string>();
	for (const method of methods) {
		for (const expression of [method.response.type, method.queryType?.name, method.bodyType?.name]) {
			if (!expression) continue;
			for (const type of referencedTypes(expression, domainTypes)) {
				if (imported.has(type.name)) continue;
				imported.add(type.name);
				importLines.push(
					`import type { ${type.name} } from '${aggregateAlias}/Domain/${type.layer}/${type.fileName ?? toTypeFileName(type.name)}';`
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
		if (names.size) importLines.push(`import type { ${[...names].join(', ')} } from '${aggregateAlias}/Domain';`);
	}
	const methodsCode = methods.map((method) => buildRepositoryMethodCode(method)).join('\n\n');
	const typeImportLine = importLines.join('\n') + '\n';

	return `import type { ${datasource.interfaceName ?? 'I' + datasource.name} } from '${datasource.importPath}';
${typeImportLine}
export class ${meta.className} implements ${meta.repositoryInterfaceName} {
\tconstructor(private readonly datasource: ${datasource.interfaceName ?? 'I' + datasource.name}) {}

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
	await ensureDomainScaffold(contextName, domainName);
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
	const interfacePath = path.join(resolveDomainRootPath(contextName, domainName), 'Ports', interfaceFileName + '.ts');

	let interfaceContent = '';
	try {
		interfaceContent = await fs.readFile(interfacePath, 'utf-8');
	} catch {
		console.error(`❌ Repository interface not found: ${interfacePath}`);
		return false;
	}

	const methods = parseRepositoryMethodsFromInterface(interfaceContent);
	const useCasesPath = resolveUseCasesPath(contextName, domainName);
	await fs.mkdir(useCasesPath, { recursive: true });

	let dependencyName = meta.repositoryDependencyName;
	while (methods.includes(dependencyName)) dependencyName += 'Repository';
	const declares = methods.map((methodName) => `\tdeclare ${methodName}: ${meta.repositoryInterfaceName}['${methodName}'];`).join('\n');

	const aggregateAlias = contextAlias + '/' + domainName;
	const content = `import { ClassMirror } from '@azure-net/kit';
import type { ${meta.repositoryInterfaceName} } from '${aggregateAlias}/Domain/Ports/${interfaceFileName}';

export interface I${meta.useCasesClassName} {
${methods.map((name) => `  ${name}: ${meta.repositoryInterfaceName}['${name}'];`).join('\n')}
}

export class ${meta.useCasesClassName} extends ClassMirror implements I${meta.useCasesClassName} {
\tconstructor(private ${dependencyName}: ${meta.repositoryInterfaceName}) {
\t\tsuper(${dependencyName});
\t}

${declares ? `${declares}\n` : ''}
}
`;

	const created = await writeIfNotExists(path.join(useCasesPath, `${meta.useCasesClassName}.ts`), content);
	if (!created) return false;
	return true;
};

export const resolveDomainForRepository = async ({
	contextName,
	contextAlias,
	aggregateName,
	repositoryName
}: {
	contextName: string;
	contextAlias: string;
	aggregateName?: string;
	repositoryName: string;
}): Promise<string | null> => {
	void contextAlias;
	const repositoryPath = path.join(resolveRepositoriesPath(contextName, aggregateName), `${ensureRepositoryName(repositoryName)}.ts`);
	try {
		const content = await fs.readFile(repositoryPath, 'utf-8');
		return content.includes('/Domain') ? (aggregateName ?? toPascalCase(contextName)) : null;
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

export const ensureDomainScaffold = async (contextName: string, aggregate = contextName): Promise<void> => {
	const root = resolveDomainRootPath(contextName, aggregate);
	for (const layer of ['Resources', 'DTO', 'Ports', 'Enums']) {
		const directory = path.join(root, layer);
		await fs.mkdir(directory, { recursive: true });
		await updateIndexTs(directory);
	}
	await writeIfNotExists(
		path.join(root, 'index.ts'),
		"export * from './Resources';\nexport * from './DTO';\nexport * from './Ports';\nexport * from './Enums';\n"
	);
};

export const printApplicationProviderWiring = (context: string, repository: string, datasource: string, aggregate = context): void => {
	const meta = getRepositoryMeta(repository);
	console.log(`Wire #contexts/${context}/Composition.ts:
import { ${meta.className} } from '#contexts/${context}/${aggregate}/Infrastructure/Repositories/${meta.className}';
import { ${meta.useCasesClassName} } from '#contexts/${context}/${aggregate}/Application/UseCases/${meta.useCasesClassName}';
// dependsOn: { HttpProvider }, register: ({ HttpProvider }) => ({
// ${meta.useCasesClassName}: () => new ${meta.useCasesClassName}(new ${meta.className}(HttpProvider.${datasource}))
// })
`);
};
