import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import ts from 'typescript';
import { selectWorkspace, selectScope, selectAggregate, getAggregatePath, getContextPath } from '../../utils/architecture.js';
import { toPascalCase } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
import { getConfigState, resolveContextAlias, selectContext } from './repositoryModuleShared.js';
import { loadUserConfig } from '../../utils/loadConfig.js';
import { getFoundationConstructImportPath, getFoundationConstructPath, getSharedState } from '../../utils/sharedFoundation.js';

type MethodParam = { name: string; type: string };
type RepositoryMethod = { name: string; params: MethodParam[]; responseType: string };
type UseCasesInfo = { repositoryInterfaceName: string | null; domainName: string | null; methods: string[] };
type ProviderInfo = { providerName: string; services: Map<string, string> };

export const parseProviderInfo = (content: string): ProviderInfo => {
	const source = ts.createSourceFile('Composition.ts', content, ts.ScriptTarget.Latest, true);
	const services = new Map<string, string>();
	const aliases = new Map<string, string>();
	for (const statement of source.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			statement.importClause?.namedBindings &&
			ts.isNamedImports(statement.importClause.namedBindings)
		) {
			for (const specifier of statement.importClause.namedBindings.elements)
				aliases.set(specifier.name.text, specifier.propertyName?.text ?? specifier.name.text);
		}
	}
	const unwrap = (expression: ts.Expression): ts.Expression =>
		ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
	const returnValues = (fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] => {
		if (!ts.isBlock(fn.body)) return [unwrap(fn.body)];
		const values: ts.Expression[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isReturnStatement(node) && node.expression) values.push(unwrap(node.expression));
			else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
		};
		ts.forEachChild(fn.body, visit);
		return values;
	};
	const visit = (node: ts.Node) => {
		if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/['"]/g, '') === 'register') {
			const register = unwrap(node.initializer);
			if (ts.isArrowFunction(register) || ts.isFunctionExpression(register)) {
				for (const value of returnValues(register)) {
					if (!ts.isObjectLiteralExpression(value)) continue;
					for (const property of value.properties) {
						if (!ts.isPropertyAssignment(property)) continue;
						const factory = unwrap(property.initializer);
						if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) continue;
						for (const instance of returnValues(factory)) {
							if (ts.isNewExpression(instance) && ts.isIdentifier(instance.expression)) {
								services.set(
									property.name.getText(source).replace(/['"]/g, ''),
									aliases.get(instance.expression.text) ?? instance.expression.text
								);
							}
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { providerName: 'Composition', services };
};

export const parseUseCasesInfo = (content: string): UseCasesInfo => {
	const source = ts.createSourceFile('UseCases.ts', content, ts.ScriptTarget.Latest, true);
	const imported = new Map<string, string>();
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			!statement.moduleSpecifier.text.includes('/Domain')
		)
			continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings))
			for (const item of bindings.elements) imported.set(item.name.text, item.propertyName?.text ?? item.name.text);
	}
	const methods: string[] = [];
	let repositoryInterfaceName: string | null = null;
	for (const statement of source.statements)
		if (ts.isClassDeclaration(statement)) {
			for (const member of statement.members) {
				if (!ts.isPropertyDeclaration(member) || !member.type || !ts.isIndexedAccessTypeNode(member.type)) continue;
				const owner = member.type.objectType.getText(source);
				if (!imported.has(owner)) continue;
				repositoryInterfaceName = imported.get(owner)!;
				methods.push(member.name.getText(source));
			}
			if (!repositoryInterfaceName)
				for (const member of statement.members)
					if (ts.isConstructorDeclaration(member)) {
						for (const parameter of member.parameters) {
							const owner = parameter.type?.getText(source);
							if (owner && imported.has(owner)) repositoryInterfaceName = imported.get(owner)!;
						}
					}
		}
	return { repositoryInterfaceName, domainName: repositoryInterfaceName ? 'Domain' : null, methods };
};

export const parseRepositoryInterfaceMethods = (content: string, interfaceName?: string): RepositoryMethod[] => {
	const source = ts.createSourceFile('Repository.ts', content, ts.ScriptTarget.Latest, true);
	const methods: RepositoryMethod[] = [];
	for (const statement of source.statements) {
		if (!ts.isInterfaceDeclaration(statement) || (interfaceName && statement.name.text !== interfaceName)) continue;
		for (const member of statement.members) {
			if (!ts.isMethodSignature(member) || !member.type) continue;
			const result =
				ts.isTypeReferenceNode(member.type) && member.type.typeName.getText(source) === 'Promise'
					? member.type.typeArguments?.[0]
					: member.type;
			methods.push({
				name: member.name.getText(source),
				params: member.parameters.map((parameter) => ({
					name: parameter.name.getText(source) + (parameter.questionToken ? '?' : ''),
					type: parameter.type?.getText(source) ?? 'unknown'
				})),
				responseType: result?.getText(source) ?? 'unknown'
			});
		}
	}
	return methods;
};

const findRepositoryByInterface = async (
	contextName: string,
	aggregateName: string,
	repositoryInterfaceName: string
): Promise<{ filePath: string; content: string } | null> => {
	const repositoriesPath = path.join(getAggregatePath(contextName, aggregateName), 'Infrastructure', 'Repositories');
	try {
		const files = await fs.readdir(repositoriesPath);
		for (const fileName of files) {
			if (!fileName.endsWith('.ts') || fileName === 'index.ts') continue;
			const absolute = path.join(repositoriesPath, fileName);
			const content = await fs.readFile(absolute, 'utf-8');
			if (content.includes(`implements ${repositoryInterfaceName}`)) {
				return { filePath: absolute, content };
			}
		}
		return null;
	} catch {
		return null;
	}
};

export const parseRepositoryHttpMethods = (content: string): Map<string, string> => {
	const source = ts.createSourceFile('Repository.ts', content, ts.ScriptTarget.Latest, true);
	const methods = new Map<string, string>();
	for (const statement of source.statements)
		if (ts.isClassDeclaration(statement)) {
			for (const member of statement.members)
				if (ts.isMethodDeclaration(member) && member.body) {
					const visit = (node: ts.Node): void => {
						if (
							ts.isCallExpression(node) &&
							ts.isPropertyAccessExpression(node.expression) &&
							node.expression.expression.getText(source) === 'http' &&
							/^(get|post|put|delete|head|options|patch)$/.test(node.expression.name.text)
						) {
							methods.set(member.name.getText(source), node.expression.name.text);
						}
						ts.forEachChild(node, visit);
					};
					visit(member.body);
				}
		}
	return methods;
};

const getSharedSchemaFactories = async (): Promise<string[]> => {
	const { sharedContext } = await getSharedState();
	const schemaPath = getFoundationConstructPath(sharedContext.name, 'schema');
	try {
		const files = await fs.readdir(schemaPath);
		return files.filter((item) => item.endsWith('.ts') && item !== 'index.ts').map((item) => item.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

const normalizePresenterName = (rawName: string | undefined, fallbackUseCasesName: string): string => {
	const fallback = fallbackUseCasesName.replace(/UseCases$/, '') || 'Module';
	const source = String(rawName ?? '').trim() || fallback;
	const normalized = toPascalCase(source);
	return normalized.endsWith('Presenter') ? normalized : `${normalized}Presenter`;
};

export const normalizeTypeImports = (types: string[]): string[] => {
	const names = new Set<string>();
	const source = ts.createSourceFile(
		'Types.ts',
		types.map((type, index) => 'type T' + index + ' = ' + type + ';').join('\n'),
		ts.ScriptTarget.Latest,
		true
	);
	const visit = (node: ts.Node): void => {
		// Domain declarations use I/T prefixes. Built-in generics and primitive keywords need no import.
		if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && /^[IT][A-Z]/.test(node.typeName.text))
			names.add(node.typeName.text);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return [...names];
};
const isPathParamName = (name: string): boolean => name.replace(/\?$/, '') === 'pathParam' || name.replace(/\?$/, '') === 'path';
const toTypeFileName = (typeName: string): string => String(typeName ?? '').replace(/^I/, '') || 'Type';

const buildMethodInvocation = (
	method: RepositoryMethod & { httpMethod: string },
	useCasesName: string,
	schemaByMethod: Map<string, { constName: string }>
): string => {
	const paramsSignature = method.params.map((item) => `${item.name}: ${item.type}`).join(', ');
	const argNames = method.params.map((item) => item.name.replace(/\?$/, ''));
	const requestParam =
		method.params.find((item) => item.name.replace(/\?$/, '') === 'request') ?? method.params.find((item) => !isPathParamName(item.name));
	const schemaInfo = schemaByMethod.get(method.name) ?? null;
	const args = argNames.map((argName) => {
		if (schemaInfo && requestParam && argName === requestParam.name.replace(/\?$/, '')) {
			return `${schemaInfo.constName}.from(${argName}).toJson()`;
		}
		return argName;
	});

	const httpMethod = method.httpMethod;
	if (httpMethod === 'get' || httpMethod === 'head' || httpMethod === 'options') {
		return `\t${method.name}(${paramsSignature}) { return createAsyncResource(() => ${useCasesName}.${method.name}(${args.join(', ')})); }`;
	}

	return `\t${method.name}(${paramsSignature}) { return createAsyncAction(() => ${useCasesName}.${method.name}(${args.join(', ')})); }`;
};

const getCompositionFile = async (context: string): Promise<string | null> => {
	const targetPath = path.join(getContextPath(context), 'Composition.ts');
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
		return null;
	}
};

const resolveDomainInterfaceFile = async ({
	contextName,
	domainName,
	interfaceName
}: {
	contextName: string;
	domainName: string;
	interfaceName: string;
}): Promise<string | null> => {
	const portsPath = path.join(getAggregatePath(contextName, domainName), 'Domain', 'Ports');
	const preferredPath = path.join(portsPath, `${toTypeFileName(interfaceName)}.ts`);
	const legacyPath = path.join(portsPath, `${interfaceName}.ts`);

	for (const candidate of [preferredPath, legacyPath]) {
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Try the next candidate.
		}
	}

	try {
		const files = await fs.readdir(portsPath);
		for (const fileName of files) {
			if (!fileName.endsWith('.ts') || fileName === 'index.ts') continue;
			const candidate = path.join(portsPath, fileName);
			const content = await fs.readFile(candidate, 'utf-8');
			const escapedName = interfaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			if (new RegExp(`export\\s+interface\\s+${escapedName}\\b`).test(content)) {
				return candidate;
			}
		}
	} catch {
		return null;
	}

	return null;
};

export type GeneratePresenterOptions = {
	aggregateName?: string;
	workspace?: { name?: string; path: string };
	scope?: string;
	presenterName?: string;
	schemas?: boolean;
	contextName?: string;
	useCasesName?: string;
};

export default async function generatePresenter(options: GeneratePresenterOptions = {}): Promise<void> {
	let contextName: string | null = options.contextName ? String(options.contextName) : null;
	if (!contextName) {
		contextName = await selectContext('Select context for presenter:');
	}
	if (!contextName) {
		process.exitCode = 1;
		return;
	}

	const aggregateName = options.aggregateName ?? (await selectAggregate(contextName));
	if (!aggregateName) return;
	const appProviderFile = await getCompositionFile(contextName);
	if (!appProviderFile) {
		console.error('❌ Composition file was not found.');
		process.exitCode = 1;
		return;
	}

	const appProviderContent = await fs.readFile(appProviderFile, 'utf-8');
	const providerInfo = parseProviderInfo(appProviderContent);

	const useCasesPath = path.join(getAggregatePath(contextName, aggregateName), 'Application', 'UseCases');
	let useCasesFiles: string[] = [];
	try {
		useCasesFiles = (await fs.readdir(useCasesPath))
			.filter((item) => item.endsWith('.ts') && item !== 'index.ts')
			.map((item) => item.replace(/\.ts$/, ''));
	} catch {
		// ignore
	}

	const registeredUseCases = useCasesFiles.filter((item) => [...providerInfo.services.values()].includes(item));
	if (!registeredUseCases.length) {
		console.error('❌ No registered UseCases were found in Composition register().');
		process.exitCode = 1;
		return;
	}

	let useCasesName = options.useCasesName ? String(options.useCasesName) : '';
	if (!useCasesName) {
		const { selectedUseCases } = await prompts({
			type: 'select',
			name: 'selectedUseCases',
			message: 'Select UseCases:',
			choices: registeredUseCases.map((item) => ({ title: item, value: item })),
			initial: 0
		});
		useCasesName = String(selectedUseCases ?? '');
	}

	if (!registeredUseCases.includes(useCasesName)) {
		console.error(`❌ UseCases "${useCasesName}" is not registered in Composition.`);
		process.exitCode = 1;
		return;
	}

	const serviceKeys = [...providerInfo.services.entries()].filter(([, className]) => className === useCasesName).map(([key]) => key);
	let serviceName = serviceKeys[0]!;
	if (serviceKeys.length > 1) {
		const answer = await prompts({
			type: 'select',
			name: 'service',
			message: 'Select registered service:',
			choices: serviceKeys.map((key) => ({ title: key, value: key }))
		});
		if (!answer.service) return;
		serviceName = String(answer.service);
	}

	const useCasesFile = path.join(useCasesPath, `${useCasesName}.ts`);
	const useCasesContent = await fs.readFile(useCasesFile, 'utf-8');
	const useCasesInfo = parseUseCasesInfo(useCasesContent);
	if (!useCasesInfo.repositoryInterfaceName || !useCasesInfo.domainName) {
		console.error('❌ Unable to parse repository interface import from UseCases.');
		process.exitCode = 1;
		return;
	}

	const repositoryInfo = await findRepositoryByInterface(contextName, aggregateName, useCasesInfo.repositoryInterfaceName);
	if (!repositoryInfo) {
		console.error(`❌ Repository implementing ${useCasesInfo.repositoryInterfaceName} was not found.`);
		process.exitCode = 1;
		return;
	}

	const repositoryHttpMethods = parseRepositoryHttpMethods(repositoryInfo.content);
	const domainPortsInterfacePath = await resolveDomainInterfaceFile({
		contextName,
		domainName: aggregateName,
		interfaceName: useCasesInfo.repositoryInterfaceName
	});
	if (!domainPortsInterfacePath) {
		console.error(
			`❌ Repository interface "${useCasesInfo.repositoryInterfaceName}" was not found in ${path.join(
				process.cwd(),
				'src',
				'app',
				'Contexts',
				contextName,
				'Domain',
				'Ports'
			)}`
		);
		process.exitCode = 1;
		return;
	}
	const repositoryInterfaceContent = await fs.readFile(domainPortsInterfacePath, 'utf-8');
	const repositoryMethods = parseRepositoryInterfaceMethods(repositoryInterfaceContent, useCasesInfo.repositoryInterfaceName).filter(
		(method) => useCasesInfo.methods.includes(method.name)
	);

	const { presenterNameRaw } = options.presenterName
		? { presenterNameRaw: options.presenterName }
		: await prompts({
				type: 'text',
				name: 'presenterNameRaw',
				message: 'Presenter name (optional):'
			});

	const presenterName = normalizePresenterName(presenterNameRaw, useCasesName);
	const workspace = options.workspace ?? (await selectWorkspace());
	if (!workspace) return;
	const scope =
		options.scope ??
		(await selectScope({
			...workspace,
			name: workspace.name ?? '',
			alias: '#presentation' + (workspace.name ? '/' + workspace.name : '')
		}));
	if (!scope) return;
	const presentationPath = path.join(workspace.path, 'Scopes', scope);
	try {
		await fs.access(path.join(presentationPath, `${presenterName}.ts`));
		console.log('Presenter already exists; not overwritten.');
		return;
	} catch {
		/* new file */
	}
	await fs.mkdir(presentationPath, { recursive: true });

	const { contexts, sharedAlias } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName) + '/' + aggregateName;
	const schemaFactoryImportPath = getFoundationConstructImportPath(sharedAlias, 'schema');

	const mutationMethods = repositoryMethods.filter((method) => {
		const httpMethod = repositoryHttpMethods.get(method.name) ?? 'get';
		return httpMethod !== 'get' && httpMethod !== 'head' && httpMethod !== 'options';
	});

	let schemaFactory = String((await loadUserConfig()).defaultSchemaFactory ?? '').trim();
	let schemaFactoryResolved = false;
	const schemaByMethod = new Map<string, { constName: string }>();
	const schemaImports: string[] = [];
	let schemaIndexNeeded = false;

	if (mutationMethods.length) {
		for (const method of mutationMethods) {
			const requestParam =
				method.params.find((item) => item.name.replace(/\?$/, '') === 'request') ??
				method.params.find((item) => !isPathParamName(item.name));
			if (!requestParam) continue;

			const { shouldCreateSchema } =
				options.schemas !== undefined
					? { shouldCreateSchema: options.schemas }
					: await prompts({
							type: 'confirm',
							name: 'shouldCreateSchema',
							message: `Create schema for "${method.name}"?`,
							initial: false
						});

			if (!shouldCreateSchema) continue;

			if (!schemaFactoryResolved) {
				if (!schemaFactory) {
					const availableSchemas = await getSharedSchemaFactories();
					if (!availableSchemas.length) {
						console.error('❌ No schema factories found in Platform/Foundation/Schema.');
						process.exitCode = 1;
						return;
					}

					const { selectedSchemaFactory } = await prompts({
						type: 'select',
						name: 'selectedSchemaFactory',
						message: 'Select schema factory:',
						choices: availableSchemas.map((item) => ({ title: item, value: item })),
						initial: 0
					});

					schemaFactory = String(selectedSchemaFactory ?? '');
				}

				schemaFactoryResolved = true;
			}

			const schemaConstName = `${toPascalCase(method.name)}${presenterName}Schema`;
			const schemaFileName = `${schemaConstName}.ts`;
			const schemaPath = path.join(presentationPath, 'Schema');
			await fs.mkdir(schemaPath, { recursive: true });
			schemaIndexNeeded = true;

			const schemaContent = `import { ${schemaFactory} } from '${schemaFactoryImportPath}';
${normalizeTypeImports([requestParam.type]).length ? `import type { ${normalizeTypeImports([requestParam.type]).join(', ')} } from '${contextAlias}/Domain';` : ''}

export const ${schemaConstName} = ${schemaFactory}<${requestParam.type}>()
\t.rules((rules) => ({}))
\t.create();
`;

			await writeIfNotExists(path.join(schemaPath, schemaFileName), schemaContent);
			schemaByMethod.set(method.name, { constName: schemaConstName });
			schemaImports.push(schemaConstName);
		}
	}

	if (schemaIndexNeeded) {
		await updateIndexTs(path.join(presentationPath, 'Schema'));
	}

	const hasGetLike = repositoryMethods.some((method) => {
		const httpMethod = repositoryHttpMethods.get(method.name) ?? 'get';
		return httpMethod === 'get' || httpMethod === 'head' || httpMethod === 'options';
	});
	const hasMutation = repositoryMethods.some((method) => {
		const httpMethod = repositoryHttpMethods.get(method.name) ?? 'get';
		return httpMethod !== 'get' && httpMethod !== 'head' && httpMethod !== 'options';
	});

	const helperParams = [hasGetLike ? 'createAsyncResource' : null, hasMutation ? 'createAsyncAction' : null].filter(Boolean).join(', ');

	const typeImports = normalizeTypeImports(
		repositoryMethods.flatMap((method) => [method.responseType, ...method.params.map((item) => item.type)])
	);

	const methodsCode = repositoryMethods
		.map((method) => {
			const httpMethod = repositoryHttpMethods.get(method.name) ?? 'get';
			return buildMethodInvocation({ ...method, httpMethod }, 'this.useCases', schemaByMethod);
		})
		.join('\n\n');

	const schemaImportLine = schemaImports.length ? `import { ${Array.from(new Set(schemaImports)).join(', ')} } from './Schema';` : '';
	const typeImportLine = typeImports.length ? `import type { ${typeImports.join(', ')} } from '${contextAlias}/Domain';` : '';
	const presenterContent = `${helperParams ? 'import { ' + helperParams + " } from '@azure-net/kit/delivery';" : ''}
${schemaImportLine}
import type { I${useCasesName} } from '${contextAlias}/Application/UseCases/${useCasesName}';
${typeImportLine}

export class ${presenterName} {
 constructor(private readonly useCases: I${useCasesName}) {}
${methodsCode}
}
`;
	await writeIfNotExists(path.join(presentationPath, presenterName + '.ts'), presenterContent);
	const indexFile = path.join(presentationPath, 'index.ts');
	let index = '';
	try {
		index = await fs.readFile(indexFile, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const factory = 'use' + presenterName;
	if (new RegExp('\\b' + factory + '\\b').test(index)) throw new Error('Presenter binding already exists: ' + factory);
	// Alias imports per binding so several aggregates can share a scope safely.
	const alias = presenterName + 'Context';
	index += `\nimport { RegisterProvider as Register${presenterName} } from '@azure-net/kit/delivery';
import { ${contextName}Context as ${alias} } from '#contexts/${contextName}/Composition';
import { ${presenterName} } from './${presenterName}';
export const ${factory} = Register${presenterName}(() => new ${presenterName}(${alias}.resolve().${serviceName}));
`;
	await fs.writeFile(indexFile, index);

	console.log(`✅ Presenter generated: ${path.join(presentationPath, `${presenterName}.ts`)}`);
}
