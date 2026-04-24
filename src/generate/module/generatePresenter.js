import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { toKebabCase, toPascalCase } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
import { getConfigState, resolveContextAlias, selectContext } from './repositoryModuleShared.js';
import { loadUserConfig } from '../../utils/loadConfig.js';

const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean', 'unknown', 'void', 'null', 'undefined', 'bigint', 'symbol', 'never']);

const parseProviderInfo = (content) => {
	const providerNameMatch = content.match(/export\s+const\s+(\w+)\s*=\s*createBoundaryProvider/);
	const providerName = providerNameMatch?.[1] ?? 'ApplicationProvider';

	const registerMatch = content.match(/register\s*:\s*\([^)]*\)\s*=>\s*\(\{([\s\S]*?)\}\)/m);
	const registerBody = registerMatch?.[1] ?? '';
	const keys = [];
	const keyRegex = /([A-Za-z_]\w*)\s*:/g;
	let keyMatch;
	while ((keyMatch = keyRegex.exec(registerBody)) !== null) {
		keys.push(keyMatch[1]);
	}

	return { providerName, registeredKeys: keys };
};

const parseUseCasesInfo = (content) => {
	const interfaceImport = content.match(/import\s+type\s+\{\s*(\w+)\s*\}\s+from\s+['"]([^'"]+)['"]/);
	const repositoryInterfaceName = interfaceImport?.[1] ?? null;
	const domainImportPath = interfaceImport?.[2] ?? null;
	const domainNameMatch = domainImportPath?.match(/\/layers\/domain\/([^'"]+)$/);
	const domainName = domainNameMatch?.[1] ?? null;

	const methods = [];
	const declareRegex = /declare\s+(\w+)\s*:\s*\w+\['\w+'\];/g;
	let declareMatch;
	while ((declareMatch = declareRegex.exec(content)) !== null) {
		methods.push(declareMatch[1]);
	}

	return { repositoryInterfaceName, domainName, methods };
};

const parseRepositoryInterfaceMethods = (content) => {
	const methods = [];
	const regex = /(\w+)\(([^)]*)\)\s*:\s*Promise<([^>]+)>;/g;
	let match;
	while ((match = regex.exec(content)) !== null) {
		const paramsRaw = match[2].trim();
		const params = paramsRaw
			? paramsRaw.split(',').map((part) => {
					const [name, ...typeParts] = part.trim().split(':');
					return { name: name.trim(), type: typeParts.join(':').trim() };
				})
			: [];
		methods.push({
			name: match[1],
			params,
			responseType: match[3].trim()
		});
	}
	return methods;
};

const findRepositoryByInterface = async (contextName, repositoryInterfaceName) => {
	const repositoriesPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'infrastructure', 'http', 'repositories');
	try {
		const files = await fs.readdir(repositoriesPath);
		for (const fileName of files) {
			if (!fileName.endsWith('.ts') || fileName === 'index.ts') continue;
			const absolute = path.join(repositoriesPath, fileName);
			// eslint-disable-next-line no-await-in-loop
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

const parseRepositoryHttpMethods = (content) => {
	const methods = new Map();
	const regex = /public\s+async\s+(\w+)\([^)]*\)\s*\{([\s\S]*?)\n\t\}/g;
	let match;
	while ((match = regex.exec(content)) !== null) {
		const methodName = match[1];
		const body = match[2] ?? '';
		const httpMatch = body.match(/http\.(get|post|put|delete|head|options|patch)\(/);
		if (httpMatch) methods.set(methodName, httpMatch[1]);
	}
	return methods;
};

const getCorePresenterFactories = async () => {
	const presenterPath = path.join(process.cwd(), 'src', 'core', 'presenter');
	try {
		const files = await fs.readdir(presenterPath);
		return files.filter((item) => item.endsWith('.ts') && item !== 'index.ts').map((item) => item.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

const getCoreSchemaFactories = async () => {
	const schemaPath = path.join(process.cwd(), 'src', 'core', 'schema');
	try {
		const files = await fs.readdir(schemaPath);
		return files.filter((item) => item.endsWith('.ts') && item !== 'index.ts').map((item) => item.replace(/\.ts$/, ''));
	} catch {
		return [];
	}
};

const normalizePresenterName = (rawName, fallbackUseCasesName) => {
	const fallback = fallbackUseCasesName.replace(/UseCases$/, '') || 'Module';
	const source = String(rawName ?? '').trim() || fallback;
	const normalized = toPascalCase(source);
	return normalized.endsWith('Presenter') ? normalized : `${normalized}Presenter`;
};

const isPrimitive = (typeName) => PRIMITIVE_TYPES.has(String(typeName ?? '').trim());

const normalizeTypeImports = (types) => Array.from(new Set(types.filter((typeName) => !isPrimitive(typeName))));
const isPathParamName = (name) => name === 'pathParam' || name === 'path';

const buildMethodInvocation = (method, useCasesName, schemaByMethod) => {
	const paramsSignature = method.params.map((item) => `${item.name}: ${item.type}`).join(', ');
	const argNames = method.params.map((item) => item.name);
	const requestParam = method.params.find((item) => !isPathParamName(item.name));
	const schemaInfo = schemaByMethod.get(method.name) ?? null;
	const args = argNames.map((argName) => {
		if (schemaInfo && requestParam && argName === requestParam.name) {
			return `${schemaInfo.constName}.from(${argName}).json()`;
		}
		return argName;
	});

	const httpMethod = method.httpMethod;
	if (httpMethod === 'get' || httpMethod === 'head' || httpMethod === 'options') {
		return `\tconst ${method.name} = (${paramsSignature}) => createAsyncResource(() => ${useCasesName}.${method.name}(${args.join(', ')}));`;
	}

	const responseType = method.responseType;
	const requestType = requestParam?.type ?? null;
	let generic = `<${responseType}`;
	if (requestType) generic += `, ${requestType}`;
	generic += '>';

	return `\tconst ${method.name} = async (${paramsSignature}) =>\n\t\tawait createAsyncAction${generic}(() => ${useCasesName}.${method.name}(${args.join(', ')}));`;
};

const getApplicationProviderFile = async (contextName) => {
	const providersPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'application', 'providers');
	const targetPath = path.join(providersPath, 'ApplicationProvider.ts');
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
		const files = await fs.readdir(providersPath);
		const candidate = files.find((item) => item.endsWith('.ts') && item !== 'index.ts');
		return candidate ? path.join(providersPath, candidate) : null;
	}
};

export default async function generatePresenter(options = {}) {
	let contextName = options.contextName ? String(options.contextName) : null;
	if (!contextName) {
		contextName = await selectContext('Select context for presenter:');
	}
	if (!contextName) {
		process.exitCode = 1;
		return;
	}

	const appProviderFile = await getApplicationProviderFile(contextName);
	if (!appProviderFile) {
		console.error('❌ ApplicationProvider file was not found.');
		process.exitCode = 1;
		return;
	}

	const appProviderContent = await fs.readFile(appProviderFile, 'utf-8');
	const providerInfo = parseProviderInfo(appProviderContent);

	const useCasesPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'application', 'use-cases');
	let useCasesFiles = [];
	try {
		useCasesFiles = (await fs.readdir(useCasesPath))
			.filter((item) => item.endsWith('.ts') && item !== 'index.ts')
			.map((item) => item.replace(/\.ts$/, ''));
	} catch {
		// ignore
	}

	const registeredUseCases = useCasesFiles.filter((item) => providerInfo.registeredKeys.includes(item));
	if (!registeredUseCases.length) {
		console.error('❌ No registered UseCases were found in ApplicationProvider register().');
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
		console.error(`❌ UseCases "${useCasesName}" is not registered in ApplicationProvider.`);
		process.exitCode = 1;
		return;
	}

	const useCasesFile = path.join(useCasesPath, `${useCasesName}.ts`);
	const useCasesContent = await fs.readFile(useCasesFile, 'utf-8');
	const useCasesInfo = parseUseCasesInfo(useCasesContent);
	if (!useCasesInfo.repositoryInterfaceName || !useCasesInfo.domainName) {
		console.error('❌ Unable to parse repository interface import from UseCases.');
		process.exitCode = 1;
		return;
	}

	const repositoryInfo = await findRepositoryByInterface(contextName, useCasesInfo.repositoryInterfaceName);
	if (!repositoryInfo) {
		console.error(`❌ Repository implementing ${useCasesInfo.repositoryInterfaceName} was not found.`);
		process.exitCode = 1;
		return;
	}

	const repositoryHttpMethods = parseRepositoryHttpMethods(repositoryInfo.content);
	const domainPortsInterfacePath = path.join(
		process.cwd(),
		'src',
		'app',
		contextName,
		'layers',
		'domain',
		useCasesInfo.domainName,
		'ports',
		`${useCasesInfo.repositoryInterfaceName}.ts`
	);
	const repositoryInterfaceContent = await fs.readFile(domainPortsInterfacePath, 'utf-8');
	const repositoryMethods = parseRepositoryInterfaceMethods(repositoryInterfaceContent).filter((method) =>
		useCasesInfo.methods.includes(method.name)
	);

	const { presenterNameRaw } = await prompts({
		type: 'text',
		name: 'presenterNameRaw',
		message: 'Presenter name (optional):'
	});

	const presenterName = normalizePresenterName(presenterNameRaw, useCasesName);
	const presenterFolder = toKebabCase(presenterName.replace(/Presenter$/, ''));
	const presentationPath = path.join(process.cwd(), 'src', 'app', contextName, 'layers', 'presentation', presenterFolder);
	await fs.mkdir(presentationPath, { recursive: true });

	const { contexts, coreAlias } = await getConfigState();
	const contextAlias = resolveContextAlias(contexts, contextName);

	let presenterFactory = String((await loadUserConfig()).defaultPresenterFactory ?? '').trim();
	let useNativePresenter = false;
	if (!presenterFactory) {
		const availableFactories = await getCorePresenterFactories();
		const { selectedFactory } = await prompts({
			type: 'select',
			name: 'selectedFactory',
			message: 'Select presenter factory:',
			choices: [
				...availableFactories.map((item) => ({ title: item, value: item })),
				{ title: 'Native createPresenter', value: '__native__' }
			],
			initial: 0
		});

		if (selectedFactory === '__native__') {
			useNativePresenter = true;
			presenterFactory = 'createPresenter';
		} else {
			presenterFactory = String(selectedFactory ?? '');
		}
	}

	if (!presenterFactory) {
		useNativePresenter = true;
		presenterFactory = 'createPresenter';
	}

	const mutationMethods = repositoryMethods.filter((method) => {
		const httpMethod = repositoryHttpMethods.get(method.name) ?? 'get';
		return httpMethod !== 'get' && httpMethod !== 'head' && httpMethod !== 'options';
	});

	let schemaFactory = String((await loadUserConfig()).defaultSchemaFactory ?? '').trim();
	let schemaFactoryResolved = false;
	const schemaByMethod = new Map();
	const schemaImports = [];
	let schemaIndexNeeded = false;

	if (mutationMethods.length) {
		for (const method of mutationMethods) {
			const requestParam = method.params.find((item) => !isPathParamName(item.name));
			if (!requestParam) continue;

			const { shouldCreateSchema } = await prompts({
				type: 'confirm',
				name: 'shouldCreateSchema',
				message: `Create schema for "${method.name}"?`,
				initial: false
			});

			if (!shouldCreateSchema) continue;

			if (!schemaFactoryResolved) {
				if (!schemaFactory) {
					const availableSchemas = await getCoreSchemaFactories();
					if (!availableSchemas.length) {
						console.error('❌ No schema factories found in src/core/schema.');
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
			const schemaPath = path.join(presentationPath, 'schema');
			await fs.mkdir(schemaPath, { recursive: true });
			schemaIndexNeeded = true;

			const schemaContent = `import { ${schemaFactory} } from '${coreAlias}/schema';
import type { ${requestParam.type} } from '${contextAlias}/layers/domain/${useCasesInfo.domainName}';

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
		await updateIndexTs(path.join(presentationPath, 'schema'));
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
			return buildMethodInvocation({ ...method, httpMethod }, useCasesName, schemaByMethod);
		})
		.join('\n\n');

	const factoryImport = useNativePresenter
		? `import { createPresenter } from '@azure-net/kit/delivery';`
		: `import { ${presenterFactory} } from '${coreAlias}/presenter';`;

	const schemaImportLine = schemaImports.length ? `import { ${Array.from(new Set(schemaImports)).join(', ')} } from './schema';` : '';
	const typeImportLine = typeImports.length
		? `import type { ${typeImports.join(', ')} } from '${contextAlias}/layers/domain/${useCasesInfo.domainName}';`
		: '';

	const presenterId = `${toPascalCase(contextName)}${presenterName}`;
	const presenterContent = `${factoryImport}
import { ${providerInfo.providerName} } from '${contextAlias}/layers/application/providers';
${typeImportLine}
${schemaImportLine}

export const ${presenterName} = ${presenterFactory}('${presenterId}', ({ ${helperParams} }) => {
\tconst { ${useCasesName} } = ${providerInfo.providerName}();

${methodsCode ? `${methodsCode}\n` : ''}
\treturn { ${repositoryMethods.map((method) => method.name).join(', ')} };
});
`;

	await writeIfNotExists(path.join(presentationPath, `${presenterName}.ts`), presenterContent);
	await fs.writeFile(path.join(presentationPath, 'index.ts'), `export * from './${presenterName}';\n`, 'utf-8');

	console.log(`✅ Presenter generated: ${path.join(presentationPath, `${presenterName}.ts`)}`);
}
