import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import prompts from 'prompts';
import {
	getDomainTypes,
	getRepositoryMeta,
	getAvailableTsNames,
	selectContext,
	resolveRepositoriesPath,
	resolveDomainRootPath,
	resolveUseCasesPath,
	promptMethodDefinition,
	buildRepositoryContent,
	buildRepositoryMethodCode
} from './repositoryModuleShared.js';

const parse = (content: string) => ts.createSourceFile('Source.ts', content, ts.ScriptTarget.Latest, true);

export function addTypeImports(content: string, generated: string): string {
	const existing = new Set<string>();
	for (const node of parse(content).statements)
		if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
			if (node.name) existing.add(node.name.text);
		}
	for (const statement of parse(content).statements)
		if (ts.isImportDeclaration(statement)) {
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) existing.add(item.name.text);
		}
	const additions: string[] = [];
	for (const statement of parse(generated).statements)
		if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) {
			const bindings = statement.importClause.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) continue;
			const names = bindings.elements.filter((item) => !existing.has(item.name.text)).map((item) => item.name.text);
			if (names.length) additions.push(`import type { ${names.join(', ')} } from ${statement.moduleSpecifier.getText()};`);
		}
	if (!additions.length) return content;
	const imports = parse(content).statements.filter(ts.isImportDeclaration);
	const end = imports.at(-1)?.end ?? 0;
	return content.slice(0, end) + '\n' + additions.join('\n') + '\n' + content.slice(end);
}

export default async function generateRepositoryMethod(): Promise<void> {
	const context = await selectContext();
	if (!context) return;
	const names = await getAvailableTsNames(resolveRepositoriesPath(context));
	if (!names.length) throw new Error('No repositories found in this context.');
	const answer = await prompts({
		type: 'select',
		name: 'repository',
		message: 'Repository:',
		choices: names.map((name) => ({ title: name, value: name }))
	});
	if (!answer.repository) return;
	const meta = getRepositoryMeta(answer.repository);
	const repositoryFile = path.join(resolveRepositoriesPath(context), meta.className + '.ts');
	const types = await getDomainTypes(context);
	const contract = types.find((type) => type.name === meta.repositoryInterfaceName && type.layer === 'Ports');
	if (!contract) throw new Error(`Interface ${meta.repositoryInterfaceName} was not found in Domain/Ports.`);
	const interfaceFile = path.join(resolveDomainRootPath(context), 'Ports', contract.fileName + '.ts');
	const method = await promptMethodDefinition(types);
	if (!method) return;
	const repositoryContent = await fs.readFile(repositoryFile, 'utf8');
	const interfaceContent = await fs.readFile(interfaceFile, 'utf8');
	const repositoryNode = parse(repositoryContent).statements.find(
		(node) => ts.isClassDeclaration(node) && node.name?.text === meta.className
	) as ts.ClassDeclaration | undefined;
	const interfaceNode = parse(interfaceContent).statements.find(
		(node) => ts.isInterfaceDeclaration(node) && node.name.text === meta.repositoryInterfaceName
	) as ts.InterfaceDeclaration | undefined;
	if (!repositoryNode || !interfaceNode)
		throw new Error('Unable to locate the repository class and its interface. Files were not changed.');
	if ([...repositoryNode.members, ...interfaceNode.members].some((member) => member.name?.getText() === method.name))
		throw new Error(`Method ${method.name} already exists.`);
	const generated = buildRepositoryContent({
		meta,
		contextAlias: `#contexts/${context}`,
		domainName: context,
		domainTypes: types,
		datasource: { name: 'Datasource', importPath: 'unused' },
		methods: [method]
	});
	const params = [
		method.pathParamType ? `pathParam: ${method.pathParamType}` : '',
		method.queryType ? `request: ${method.queryType.name}` : '',
		method.bodyType ? `request: ${method.bodyType.name}` : ''
	]
		.filter(Boolean)
		.join(', ');
	const signature = `\n\t${method.name}(${params}): Promise<${method.response.type}>;\n`;
	const repositoryNext = addTypeImports(
		repositoryContent.slice(0, repositoryNode.end - 1) +
			'\n' +
			buildRepositoryMethodCode(method) +
			'\n' +
			repositoryContent.slice(repositoryNode.end - 1),
		generated
	);
	const interfaceNext = addTypeImports(
		interfaceContent.slice(0, interfaceNode.end - 1) + signature + interfaceContent.slice(interfaceNode.end - 1),
		generated
	);
	const useCasesFile = path.join(resolveUseCasesPath(context), meta.useCasesClassName + '.ts');
	let useCasesContent: string | undefined;
	try {
		useCasesContent = await fs.readFile(useCasesFile, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	let useCasesNext: string | undefined;
	if (useCasesContent !== undefined) {
		const node = parse(useCasesContent).statements.find(
			(item) => ts.isClassDeclaration(item) && item.name?.text === meta.useCasesClassName
		) as ts.ClassDeclaration | undefined;
		if (!node) throw new Error('Unable to update existing UseCases safely. Files were not changed.');
		if (!node.members.some((member) => member.name?.getText() === method.name))
			useCasesNext =
				useCasesContent.slice(0, node.end - 1) +
				`\n\tdeclare ${method.name}: ${meta.repositoryInterfaceName}['${method.name}'];\n` +
				useCasesContent.slice(node.end - 1);
	}
	await fs.writeFile(repositoryFile, repositoryNext);
	await fs.writeFile(interfaceFile, interfaceNext);
	if (useCasesNext !== undefined) await fs.writeFile(useCasesFile, useCasesNext);
	console.log(`Added ${method.name} to ${meta.className}, its contract and existing UseCases.`);
}
