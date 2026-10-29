import { migrateCurrentApis } from './currentApis.js';
import { migrateCompositionSource } from './composition.js';
import { migratePresenterLayout } from './presenterLayout.js';
import { migrateTranslationsSources } from './translations.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import prompts from 'prompts';
import { normalizePascalName } from '../utils/architecture.js';
import { VITE_CONFIGS } from '../utils/viteConfig.js';
import { PACKAGE_IMPORTS, resolvePackageImport } from '../utils/packageImports.js';
import { migrateConfig } from './config.js';
import { parseSource } from '../checks/architecture.js';
import { inspectFactories, replaceFactory, type FactoryDefinition } from './presenterFactories.js';
import { migrateAsyncHelpers, migratePresenterSource, type PresenterDependencies, type ServiceContract } from './presenters.js';

export type MigrationIssue = { file: string; reason: string };
export type MigrationPlan = {
	root: string;
	moves: { from: string; to: string }[];
	issues: MigrationIssue[];
	writes: Map<string, Buffer>;
	originals: Map<string, Buffer>;
	removes: string[];
	workspaces: string[];
};
const slash = (s: string): string => s.split(path.sep).join('/');
const textFile = /\.(?:[cm]?[jt]sx?|svelte|css|scss|sass|less|json|html|svg)$/;
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const propName = (n: ts.Node | undefined): string | undefined => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined);

const platformTargets = new Set(
	['', '/index.ts', '/*', '/*.ts', '/*/index.ts'].flatMap((suffix) => ['./src/app/Platform', './src/platform'].map((base) => base + suffix))
);
function knownPlatformImport(value: unknown): boolean {
	if (typeof value === 'string') return platformTargets.has(value);
	if (Array.isArray(value)) return value.length > 0 && value.every(knownPlatformImport);
	return !!value && typeof value === 'object' && Object.keys(value).length > 0 && Object.values(value).every(knownPlatformImport);
}
function knownArchitectureImport(key: string, value: unknown): boolean {
	const base = key.startsWith('#contexts') ? './src/app/Contexts' : './src/app/Presentation';
	if (typeof value === 'string') return ['', '/index.ts', '/*', '/*.ts', '/*/index.ts'].some((suffix) => value === base + suffix);
	if (Array.isArray(value)) return value.length > 0 && value.every((item) => knownArchitectureImport(key, item));
	return (
		!!value &&
		typeof value === 'object' &&
		Object.keys(value).length > 0 &&
		Object.values(value).every((item) => knownArchitectureImport(key, item))
	);
}
async function assertSafeTarget(root: string, file: string): Promise<void> {
	const relative = path.relative(root, file);
	if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
		throw new Error(`Migration target outside project: ${file}`);
	let current = root;
	for (const part of ['', ...relative.split(path.sep)]) {
		current = path.join(current, part);
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Migration refuses symbolic link: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

async function files(root: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (['.backup', '.git', 'node_modules', '.svelte-kit'].includes(entry.name)) continue;
		const file = path.join(root, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Migration refuses symbolic links in source: ${file}`);
		if (entry.isDirectory()) out.push(...(await files(file)));
		else out.push(file);
	}
	return out.sort();
}
function pascalFile(file: string): string {
	if (file === 'index.ts' || file === 'index.js') return file;
	const dot = file.indexOf('.');
	const stem = (dot < 0 ? file : file.slice(0, dot)).replace(/^_(?=.*)/, '');
	return normalizePascalName(stem) + (dot < 0 ? '' : file.slice(dot));
}
function partsPath(parts: string[]): string {
	return parts.map((p, i) => (i === parts.length - 1 ? pascalFile(p) : normalizePascalName(p))).join('/');
}

export async function planMigration(root = process.cwd()): Promise<MigrationPlan> {
	root = path.resolve(root);
	const app = path.join(root, 'src/app');
	const platform = path.join(root, 'src/platform');
	const originals = new Map<string, Buffer>();
	for (const file of await files(path.join(root, 'src'))) originals.set(file, await fs.readFile(file));
	for (const name of [
		'azure-net.config.ts',
		'azure-net.config.js',
		'svelte.config.js',
		'svelte.config.ts',
		'svelte.config.mjs',
		'tsconfig.json',
		'package.json',
		...VITE_CONFIGS
	]) {
		try {
			originals.set(path.join(root, name), await fs.readFile(path.join(root, name)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	const issues: MigrationIssue[] = [];
	const issueKeys = new Set<string>();
	const issue = (file: string, reason: string): void => {
		const key = file + reason;
		if (!issueKeys.has(key)) {
			issueKeys.add(key);
			issues.push({ file, reason });
		}
	};
	const mapping = new Map<string, string>();
	const compositions = new Map<string, string>();
	const workspaces = new Set<string>();
	const aliases = new Map<string, string>([
		['$lib', path.join(root, 'src/lib')],
		['$program', path.join(root, 'src/program.ts')],
		['#platform', platform],
		['#contexts', path.join(app, 'Contexts')],
		['#presentation', path.join(app, 'Presentation')]
	]);
	const oldRoots = new Set<string>();
	for (const file of originals.keys()) {
		const relative = slash(path.relative(app, file));
		if (relative.startsWith('../')) continue;
		const first = relative.split('/')[0]!;
		if (!['Contexts', 'Presentation', 'Platform'].includes(first)) oldRoots.add(first);
	}
	for (const folder of oldRoots) aliases.set(`$${folder}`, path.join(app, folder));
	const svelteConfig = [...originals.keys()].find((p) => /svelte\.config\.(?:js|ts|mjs)$/.test(p));
	const viteConfig = [...originals.keys()].find((p) => VITE_CONFIGS.includes(path.basename(p)));
	const configPath = svelteConfig ?? viteConfig;
	const configAst = ts.createSourceFile(
		configPath ?? 'config.ts',
		configPath ? originals.get(configPath)!.toString() : '',
		ts.ScriptTarget.Latest,
		true
	);
	const packageImports = JSON.parse(originals.get(path.join(root, 'package.json'))?.toString() ?? '{}').imports ?? {};
	const readAliases = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node) && propName(node.name) === 'alias' && ts.isObjectLiteralExpression(node.initializer)) {
			for (const p of node.initializer.properties)
				if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) {
					const name = propName(p.name);
					if (name) aliases.set(name, path.resolve(root, p.initializer.text));
				}
		}
		ts.forEachChild(node, readAliases);
	};
	readAliases(configAst);
	if (viteConfig && svelteConfig)
		readAliases(ts.createSourceFile(viteConfig, originals.get(viteConfig)!.toString(), ts.ScriptTarget.Latest, true));
	function resolve(from: string, specifier: string): string | undefined {
		const clean = specifier[0]! + specifier.slice(1).split(/[?#]/)[0]!;
		let base: string | undefined;
		if (clean.startsWith('.')) base = path.resolve(path.dirname(from), clean);
		else if (clean.startsWith('#')) {
			base = resolvePackageImport(packageImports, clean, root) ?? undefined;
			if (!base)
				for (const [alias, target] of aliases) {
					if (clean === alias || clean.startsWith(alias + '/')) base = path.join(target, clean.slice(alias.length));
				}
		} else
			for (const [alias, target] of [...aliases].sort((a, b) => b[0].length - a[0].length)) {
				if (clean === alias || clean.startsWith(alias + '/')) {
					base = path.join(target, clean.slice(alias.length));
					break;
				}
			}
		if (!base) return undefined;
		for (const candidate of [
			base,
			...['.ts', '.js', '.svelte', '.scss', '.css', '/index.ts', '/index.js'].map((ext) => base + ext),
			...['.scss', '.sass', '.css'].flatMap((ext) => [
				path.join(path.dirname(base), '_' + path.basename(base) + ext),
				base + '/index' + ext,
				base + '/_index' + ext
			]),
			base.replace(/\.js$/, '.ts')
		]) {
			if (originals.has(candidate)) return candidate;
		}
		return undefined;
	}
	const domains = new Map<string, Set<string>>();
	for (const file of originals.keys()) {
		const m = slash(path.relative(app, file)).match(/^([^/]+)\/layers\/domain\/([^/]+)\//);
		if (m) {
			const names = domains.get(m[1]!) ?? new Set();
			names.add(m[2]!);
			domains.set(m[1]!, names);
		}
	}
	const backup = (file: string, why: string): string => {
		issue(file, why);
		return path.join(app, '.backup', path.relative(app, file));
	};
	for (const file of originals.keys()) {
		const rel = slash(path.relative(app, file));
		const p = rel.split('/');
		if (p[0] === 'Contexts' && p[1] && p[1] !== 'SharedKernel' && /^Composition\.[jt]s$/.test(p[2] ?? '')) {
			const converted = migrateCompositionSource(originals.get(file)!.toString(), p[1]);
			if (converted) compositions.set(file, converted);
		}
		if (p[0] === 'Platform') {
			mapping.set(file, path.join(platform, ...p.slice(1)));
			continue;
		}
		if (p[0] === 'Contexts' && p[1] !== 'SharedKernel' && ['Domain', 'Application', 'Infrastructure'].includes(p[2]!)) {
			// The earlier migrator discarded the original context/aggregate distinction.
			backup(file, 'Previous flat context layout: choose the aggregate and context manually; source retained.');
			continue;
		}
		if (!oldRoots.has(p[0]!)) continue;
		const area = p[0]!;
		let workspace: string;
		try {
			workspace = /^(shared-kernel|shared)$/i.test(area) ? 'Shared' : normalizePascalName(area);
		} catch {
			mapping.set(file, backup(file, 'Invalid legacy area name; source retained.'));
			continue;
		}
		let dest: string | undefined;
		try {
			if (p[1] === 'ui') {
				workspaces.add(workspace);
				const category = p[2]?.toLowerCase();
				if (['actions', 'style', 'components'].includes(category ?? '')) dest = `Presentation/${workspace}/Ui/${partsPath(p.slice(2))}`;
				else issue(file, 'UI category is ambiguous: choose Components/Scopes, Composite, Page or Core manually.');
			} else if (p[1] === 'layers' && p[2] === 'presentation') {
				workspaces.add(workspace);
				dest = `Presentation/${workspace}/Scopes/${partsPath(p.slice(3))}`;
			} else if (p[1] === 'layers' && p[2] === 'domain' && p.length >= 5) {
				const context = /^(shared-kernel|shared)$/i.test(area) ? 'SharedKernel' : normalizePascalName(area);
				const aggregate = normalizePascalName(p[3]!);
				const folders: Record<string, string> = { resources: 'Resources', dto: 'DTO', ports: 'Ports', enums: 'Enums', enum: 'Enums' };
				const rest = [...p.slice(4)];
				if (folders[rest[0]!]) rest[0] = folders[rest[0]!]!;
				if (['model', 'models'].includes(rest[0]!)) {
					issue(file, 'Domain model classification is ambiguous: choose Resources, DTO or another domain type manually.');
				} else
					dest =
						context === 'SharedKernel'
							? `Contexts/SharedKernel/Domain/${aggregate}/${partsPath(rest)}`
							: `Contexts/${context}/${aggregate}/Domain/${partsPath(rest)}`;
			} else if (p[1] === 'layers' && p[2] === 'application' && p[3] === 'providers' && /ApplicationProvider\.[jt]s$/.test(p.at(-1)!)) {
				const converted = migrateCompositionSource(originals.get(file)!.toString(), workspace);
				if (converted) {
					compositions.set(file, converted);
					dest = `Contexts/${workspace}/Composition.${file.endsWith('.js') ? 'js' : 'ts'}`;
				} else
					issue(
						file,
						'Composition requires manual intervention: keep the provider graph until context ownership and HttpProvider dependencies are explicit.'
					);
			} else if (
				p[1] === 'layers' &&
				(p.includes('repositories') || p.includes('repositores') || p.includes('use-cases')) &&
				!/^index\./.test(p.at(-1)!)
			) {
				const base = path.basename(file).replace(/(?:Repository|UseCases?)\.[^.]+$/, '');
				const match = [...(domains.get(area) ?? [])].filter((d) => normalizePascalName(d) === base);
				if (match.length === 1) {
					const context = normalizePascalName(area);
					dest = `Contexts/${context}/${base}/${p.includes('use-cases') ? 'Application/UseCases' : 'Infrastructure/Repositories'}/${pascalFile(p.at(-1)!)}`;
				}
			} else if (p[1] === 'runtime') dest = `Platform/Bootstrap/${partsPath(p.slice(p[2] === 'bootstrap' ? 3 : 2))}`;
			else if (['essentials', 'internal'].includes(p[1]!)) {
				if (p[2] === 'foundation') {
					const rest = p.slice(p[3] === 'constructs' ? 4 : 3);
					if (rest[0] === 'providers') rest[0] = 'Provider';
					dest = `Platform/Foundation/${partsPath(rest)}`;
				} else if (p[2] === 'localization' || p[2] === 'pipelines') dest = `Platform/Bootstrap/${partsPath(p.slice(2))}`;
				else if (p[2] === 'config') dest = `Platform/Foundation/${partsPath(p.slice(2))}`;
			}
		} catch {
			/* Invalid names are archived instead of guessed. */
		}
		mapping.set(
			file,
			dest
				? dest.startsWith('Platform/')
					? path.join(platform, dest.slice('Platform/'.length))
					: path.join(app, dest)
				: backup(file, 'No unambiguous target (legacy provider, aggregate barrel, or unsupported folder).')
		);
	}
	// No last-writer wins: preserve every conflicting file for manual resolution.
	const destinations = new Map<string, string[]>();
	for (const [from, to] of mapping) {
		const key = to.toLowerCase();
		const list = destinations.get(key) ?? [];
		list.push(from);
		destinations.set(key, list);
	}
	for (const list of destinations.values()) {
		const target = mapping.get(list[0]!)!;
		if (target.includes(`${path.sep}.backup${path.sep}`)) continue;
		if (list.length > 1 || [...originals.keys()].some((file) => file.toLowerCase() === target.toLowerCase() && !list.includes(file))) {
			for (const file of list) mapping.set(file, backup(file, `Target collision: ${target}; no file overwritten.`));
		}
	}
	const isBackup = (file: string): boolean => file.includes(`${path.sep}.backup${path.sep}`);
	// Unclassified files stay live, so their imports can follow successfully moved dependencies.
	// Original bytes are copied below, rather than making callers import an archive.
	for (const [file, target] of mapping) if (isBackup(target)) mapping.delete(file);
	function specifier(to: string, from: string): string {
		const relative = slash(path.relative(app, to));
		const relativeSpecifier = () => {
			const value = slash(path.relative(path.dirname(from), to));
			return (value.startsWith('.') ? value : './' + value).replace(/\.(?:ts|js)$/, '').replace(/\/index$/, '');
		};
		if (to.startsWith(platform + path.sep))
			return packageImports['#platform/*'] && !knownPlatformImport(packageImports['#platform/*'])
				? relativeSpecifier()
				: ('#platform/' + slash(path.relative(platform, to))).replace(/\.(?:ts|js)$/, '').replace(/\/index$/, '');
		let value: string;
		const first = relative.split('/')[0]!;
		const prefix: Record<string, string> = { Contexts: '#contexts', Presentation: '#presentation', Platform: '#platform' };
		if (
			prefix[first] &&
			packageImports[prefix[first] + '/*'] &&
			!knownArchitectureImport(prefix[first], packageImports[prefix[first] + '/*'])
		)
			return relativeSpecifier();
		if (prefix[first]) value = prefix[first] + relative.slice(first.length);
		else {
			value = slash(path.relative(path.dirname(from), to));
			if (!value.startsWith('.')) value = './' + value;
		}
		return value.replace(/\.(?:ts|js)$/, '').replace(/\/index$/, '');
	}
	function exportedSymbol(file: string, name: string, seen = new Set<string>()): { file: string; name: string } | undefined {
		const key = `${file}:${name}`;
		if (seen.has(key)) return undefined;
		seen.add(key);
		if (file.endsWith('.svelte') && name === 'default') return { file, name };
		const source = parseSource(originals.get(file)?.toString() ?? '', file);
		for (const statement of source.statements) {
			if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
				const target = resolve(file, statement.moduleSpecifier.text);
				if (!target) continue;
				if (!statement.exportClause) {
					const found = exportedSymbol(target, name, seen);
					if (found) return found;
				} else if (ts.isNamedExports(statement.exportClause))
					for (const element of statement.exportClause.elements) {
						if (element.name.text === name)
							return (
								exportedSymbol(target, element.propertyName?.text ?? name, seen) ?? {
									file: target,
									name: element.propertyName?.text ?? name
								}
							);
					}
			} else {
				if (name === 'default' && ts.isExportAssignment(statement)) return { file, name };
				if ('name' in statement && propName(statement.name as ts.Node) === name) return { file, name };
				if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => propName(d.name) === name))
					return { file, name };
			}
		}
		return undefined;
	}
	const presenterNames = new Map<string, Map<string, string>>();
	function contractsForProvider(file: string, name: string): Map<string, ServiceContract> {
		const found = new Map<string, ServiceContract>();
		const source = ts.createSourceFile(file, originals.get(file)?.toString() ?? '', ts.ScriptTarget.Latest, true);
		for (const statement of source.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (
					!ts.isIdentifier(declaration.name) ||
					declaration.name.text !== name ||
					!declaration.initializer ||
					!ts.isCallExpression(declaration.initializer)
				)
					continue;
				const settings = declaration.initializer.arguments[1];
				if (!settings || !ts.isObjectLiteralExpression(settings)) continue;
				const register = settings.properties.find((p) => propName(p.name) === 'register');
				if (!register || !ts.isPropertyAssignment(register) || !ts.isArrowFunction(register.initializer)) continue;
				let body = register.initializer.body;
				while (ts.isParenthesizedExpression(body)) body = body.expression;
				if (!ts.isObjectLiteralExpression(body)) continue;
				for (const property of body.properties) {
					if (!ts.isPropertyAssignment(property) || !ts.isArrowFunction(property.initializer)) continue;
					const create = property.initializer.body;
					if (!ts.isNewExpression(create) || !ts.isIdentifier(create.expression)) continue;
					for (const imported of source.statements) {
						if (!ts.isImportDeclaration(imported) || !ts.isStringLiteral(imported.moduleSpecifier)) continue;
						const bindings = imported.importClause?.namedBindings;
						if (!bindings || !ts.isNamedImports(bindings)) continue;
						const binding = bindings.elements.find((b) => b.name.text === create.expression.getText(source));
						if (!binding) continue;
						const target = resolve(file, imported.moduleSpecifier.text);
						const concrete = target && exportedSymbol(target, (binding.propertyName ?? binding.name).text);
						if (!concrete || !/UseCases$/.test(concrete.name)) continue;
						const contract = 'I' + concrete.name;
						const definition = ts.createSourceFile(
							concrete.file,
							originals.get(concrete.file)?.toString() ?? '',
							ts.ScriptTarget.Latest,
							true
						);
						if (
							definition.statements.some(
								(s) =>
									ts.isInterfaceDeclaration(s) &&
									s.name.text === contract &&
									s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
							)
						)
							found.set(propName(property.name) ?? '', { name: contract, source: concrete.file });
					}
				}
			}
		}
		return found;
	}
	const upgradedSources = new Map<string, string>(compositions);
	const factorySymbols = new Map<string, Set<string>>();
	const factoryDefinitions = new Map<string, FactoryDefinition[]>();
	const legacyFactories = new Set<FactoryDefinition>();
	const consumedFactories = new Set<FactoryDefinition>();
	for (const [file, bytes] of originals) {
		if (!/\.[jt]s$/.test(file)) continue;
		factoryDefinitions.set(file, inspectFactories(bytes.toString(), file));
		const source = parseSource(bytes.toString(), file);
		const creators = new Set<string>();
		for (const statement of source.statements) {
			if (
				!ts.isImportDeclaration(statement) ||
				!ts.isStringLiteral(statement.moduleSpecifier) ||
				!['@azure-net/kit/delivery', '@azure-net/edges'].includes(statement.moduleSpecifier.text)
			)
				continue;
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings))
				for (const binding of bindings.elements)
					if ((binding.propertyName ?? binding.name).text === 'createPresenterFactory') creators.add(binding.name.text);
		}
		const names = new Set<string>();
		for (const statement of source.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				const init = declaration.initializer;
				if (
					ts.isIdentifier(declaration.name) &&
					init &&
					ts.isCallExpression(init) &&
					ts.isIdentifier(init.expression) &&
					creators.has(init.expression.text)
				)
					names.add(declaration.name.text);
			}
		}
		if (names.size) factorySymbols.set(file, names);
	}
	for (const [file, bytes] of originals) {
		if (!file.startsWith(path.join(root, 'src') + path.sep) || !/\.(?:ts|js|svelte)$/.test(file)) continue;
		if (mapping.has(file) && isBackup(mapping.get(file)!)) continue;
		const source = parseSource(bytes.toString(), file);
		const factories = new Set<string>();
		const dependencies = new Map<string, PresenterDependencies>();
		const serviceContracts = new Map<string, ServiceContract>();
		const definitions = new Map<string, FactoryDefinition>();
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const bindings = statement.importClause?.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) continue;
			for (const binding of bindings.elements) {
				const name = (binding.propertyName ?? binding.name).text;
				const target = resolve(file, statement.moduleSpecifier.text);
				const symbol = target && exportedSymbol(target, name);
				if (
					(!target &&
						name === 'createPresenter' &&
						['@azure-net/kit/delivery', '@azure-net/edges'].includes(statement.moduleSpecifier.text)) ||
					(symbol && factorySymbols.get(symbol.file)?.has(symbol.name))
				)
					factories.add(binding.name.text);
				if (symbol) {
					for (const [service, contract] of contractsForProvider(symbol.file, symbol.name)) {
						let module = slash(path.relative(path.dirname(file), contract.source)).replace(/\.[jt]s$/, '');
						if (!module.startsWith('.')) module = './' + module;
						serviceContracts.set(`${binding.name.text}.${service}`, { ...contract, source: module });
					}
					const definition = factoryDefinitions.get(symbol.file)?.find((value) => value.name === symbol.name);
					if (definition) {
						let module = slash(path.relative(path.dirname(file), symbol.file)).replace(/\.[jt]s$/, '');
						if (!module.startsWith('.')) module = './' + module;
						dependencies.set(binding.name.text, { ...definition, source: module });
						definitions.set(binding.name.text, definition);
					}
				}
			}
		}
		const result = file.endsWith('.svelte')
			? { content: bytes.toString(), converted: new Map<string, string>(), issues: [] }
			: migratePresenterSource(bytes.toString(), file, factories, dependencies, serviceContracts);
		for (const [local, definition] of definitions) {
			if (result.converted.size) consumedFactories.add(definition);
			const remaining = ts.createSourceFile(file, result.content, ts.ScriptTarget.Latest, true);
			const visit = (node: ts.Node): void => {
				if (ts.isImportDeclaration(node)) return;
				if (ts.isIdentifier(node) && node.text === local) legacyFactories.add(definition);
				ts.forEachChild(node, visit);
			};
			visit(remaining);
		}
		if (result.converted.size) presenterNames.set(file, result.converted);
		for (const reason of result.issues) issue(file, reason);
		let upgraded = result.content;
		try {
			upgraded = migrateAsyncHelpers(upgraded, file);
		} catch (error) {
			issue(file, `Async helpers need manual migration: ${String(error)}`);
		}
		if (upgraded !== bytes.toString()) upgradedSources.set(file, upgraded);
	}
	for (const [file, definitions] of factoryDefinitions) {
		let content = originals.get(file)!.toString();
		let changed = false;
		for (const definition of definitions) {
			if (!consumedFactories.has(definition)) continue;
			const keepLegacy = legacyFactories.has(definition);
			content = replaceFactory(content, file, definition, keepLegacy);
			changed = true;
			if (!keepLegacy) {
				const names = presenterNames.get(file) ?? new Map<string, string>();
				names.set(definition.name, definition.exportName);
				presenterNames.set(file, names);
			} else issue(file, 'Some factory consumers could not be migrated; legacy factory retained alongside explicit dependencies.');
		}
		if (changed) {
			try {
				content = migrateAsyncHelpers(content, file);
			} catch (error) {
				issue(file, String(error));
			}
			upgradedSources.set(file, content);
		}
	}
	const translationMigration = migrateTranslationsSources(
		new Map(
			[...originals]
				.filter(([file]) => file.startsWith(path.join(root, 'src') + path.sep))
				.map(([file, bytes]) => [file, upgradedSources.get(file) ?? bytes.toString()])
		),
		resolve
	);
	for (const [file, content] of translationMigration.updates) upgradedSources.set(file, content);
	for (const problem of translationMigration.issues) issue(problem.file, problem.reason);

	for (const [file, bytes] of originals) {
		if (!/\.[jt]s$/.test(file) || isBackup(mapping.get(file) ?? file)) continue;
		const source = parseSource(upgradedSources.get(file) ?? bytes.toString(), file);
		const removed = new Set(['createPresenterFactory', 'createPresenter', 'createStoreFactory', 'createStore', 'createAsyncHelpers']);
		const apps = new Set<string>();
		for (const statement of source.statements) {
			if (
				!ts.isImportDeclaration(statement) ||
				!ts.isStringLiteral(statement.moduleSpecifier) ||
				!['@azure-net/kit', '@azure-net/kit/delivery'].includes(statement.moduleSpecifier.text)
			)
				continue;
			const bindings = statement.importClause?.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) continue;
			for (const binding of bindings.elements) {
				const name = (binding.propertyName ?? binding.name).text;
				if (removed.has(name)) issue(file, 'Removed kit API ' + name + ' remains; manual migration is required before build.');
				if (name === 'createApp') apps.add(binding.name.text);
			}
		}
		const inspect = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && apps.has(node.expression.text)) {
				const callback = node.arguments[0];
				if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
					const parameter = callback.parameters[0]?.name;
					const check = (child: ts.Node): void => {
						if (
							ts.isCallExpression(child) &&
							ts.isPropertyAccessExpression(child.expression) &&
							child.expression.name.text === 'dependencies'
						) {
							let base: ts.Expression = child.expression.expression;
							while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) base = base.expression.expression;
							if (parameter && ts.isIdentifier(parameter) && ts.isIdentifier(base) && base.text === parameter.text)
								issue(
									file,
									'createApp.dependencies/Container was removed. Move these bindings to a DiContainer; consumer changes require manual review.'
								);
						}
						ts.forEachChild(child, check);
					};
					check(callback.body);
				}
			}
			ts.forEachChild(node, inspect);
		};
		inspect(source);
	}
	// Do not flatten provider graphs: that changes lazy initialization and shared lifetimes.
	for (const [file, bytes] of originals) {
		if (!file.startsWith(path.join(root, 'src') + path.sep) || !/\.[jt]s$/.test(file) || isBackup(mapping.get(file) ?? file)) continue;
		const input = upgradedSources.get(file) ?? bytes.toString();
		const current = migrateCurrentApis(input, file);
		if (current.content !== input) upgradedSources.set(file, current.content);
		for (const reason of current.issues) issue(file, reason);
	}
	const writes = new Map<string, Buffer>();
	const replacements: { start: number; end: number; text: string }[] = [];
	function namespacePresenterName(file: string, name: string, seen = new Set<string>()): string | undefined {
		if (seen.has(file)) return undefined;
		seen.add(file);
		const direct = presenterNames.get(file)?.get(name);
		if (direct) return direct;
		const source = parseSource(originals.get(file)?.toString() ?? '', file);
		for (const statement of source.statements) {
			if (!ts.isExportDeclaration(statement)) continue;
			// Named exports keep their public alias when rewritten below.
			if (
				statement.exportClause &&
				ts.isNamedExports(statement.exportClause) &&
				statement.exportClause.elements.some((entry) => entry.name.text === name)
			)
				return name;
		}
		for (const statement of source.statements) {
			if (
				!ts.isExportDeclaration(statement) ||
				statement.exportClause ||
				!statement.moduleSpecifier ||
				!ts.isStringLiteral(statement.moduleSpecifier)
			)
				continue;
			const target = resolve(file, statement.moduleSpecifier.text);
			const renamed = target && namespacePresenterName(target, name, seen);
			if (renamed) return renamed;
		}
		return undefined;
	}
	function rewrite(file: string, destination: string, input: string): string {
		replacements.length = 0;
		const source = parseSource(input, file);
		const namespaces = new Map<string, string>();
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const bindings = statement.importClause?.namedBindings;
			const target = resolve(file, statement.moduleSpecifier.text);
			if (target && bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, target);
		}
		const replacement = (start: number, end: number, text: string): void => {
			replacements.push({ start, end, text });
		};
		const checkBoundary = (to: string): void => {
			const a = slash(path.relative(app, destination)).split('/'),
				b = slash(path.relative(app, to)).split('/');
			if (a[0] === 'Contexts' && b[0] === 'Contexts' && a[1] !== b[1] && b[1] !== 'SharedKernel')
				issue(destination, `Review cross-context dependency on ${to}; not moved into SharedKernel automatically.`);
			if (a[0] === 'Presentation' && b[0] === 'Presentation' && a[1] !== b[1] && b[1] !== 'Shared')
				issue(destination, `Review cross-workspace dependency on ${to}.`);
		};
		const newTarget = (value: string): string | undefined => {
			// SvelteKit generates these modules outside src; no physical source file is expected.
			if (/^\.\/\$types(?:\.js)?$/.test(value) && file.startsWith(path.join(root, 'src/routes') + path.sep)) return undefined;
			const resolved = resolve(file, value);
			const target = resolved && (mapping.get(resolved) ?? resolved);
			if (!target) {
				if (value.startsWith('.') || [...aliases.keys()].some((a) => value === a || value.startsWith(a + '/')))
					issue(destination, `Unresolved local module/asset: ${value}`);
				return undefined;
			}
			if (isBackup(target)) {
				issue(destination, `Import needs review: ${value} -> ${target}`);
				return undefined;
			}
			checkBoundary(target);
			return specifier(target, destination) + (value.slice(1).match(/[?#].*$/)?.[0] ?? '');
		};
		const visit = (node: ts.Node): void => {
			if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
				const target = namespaces.get(node.expression.text);
				const name = target && namespacePresenterName(target, node.name.text);
				if (name) replacement(node.name.getStart(source), node.name.end, name);
			}
			if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
				const target = namespaces.get(node.expression.text);
				const name = target && namespacePresenterName(target, node.argumentExpression.text);
				if (name) replacement(node.argumentExpression.getStart(source), node.argumentExpression.end, JSON.stringify(name));
			}
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
				const target = resolve(file, node.moduleSpecifier.text);
				const bindings = node.importClause?.namedBindings;
				if (target && bindings && ts.isNamedImports(bindings) && !node.importClause?.name) {
					const groups = new Map<string, string[]>();
					for (const e of bindings.elements) {
						const name = e.propertyName?.text ?? e.name.text;
						// Preserve barrel evaluation and public aliases, including side-effect exports.
						const to = mapping.get(target) ?? target;
						const spec = isBackup(to) ? undefined : specifier(to, destination);
						if (!spec) {
							issue(destination, `Unresolved imported symbol ${name} from ${node.moduleSpecifier.text}`);
							continue;
						}
						checkBoundary(to);
						const imported = namespacePresenterName(target, name) ?? name;
						const parts = groups.get(spec) ?? [];
						parts.push(
							`${!node.importClause?.isTypeOnly && e.isTypeOnly ? 'type ' : ''}${imported}${imported === e.name.text ? '' : ` as ${e.name.text}`}`
						);
						groups.set(spec, parts);
					}
					if ([...groups.values()].reduce((n, g) => n + g.length, 0) === bindings.elements.length) {
						replacement(
							node.getStart(source),
							node.end,
							[...groups]
								.map(
									([spec, names]) =>
										`import ${node.importClause?.isTypeOnly ? 'type ' : ''}{ ${names.join(', ')} } from ${JSON.stringify(spec)};`
								)
								.join('\n')
						);
						return;
					}
				}
				const next = newTarget(node.moduleSpecifier.text);
				if (next) replacement(node.moduleSpecifier.getStart(source), node.moduleSpecifier.end, JSON.stringify(next));
				return;
			}
			if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				const target = resolve(file, node.moduleSpecifier.text);
				if (target && node.exportClause && ts.isNamedExports(node.exportClause)) {
					for (const entry of node.exportClause.elements) {
						const name = (entry.propertyName ?? entry.name).text;
						const symbol = exportedSymbol(target, name);
						const renamed = symbol && presenterNames.get(symbol.file)?.get(symbol.name);
						if (renamed)
							replacement(entry.getStart(source), entry.end, `${entry.isTypeOnly ? 'type ' : ''}${renamed} as ${entry.name.text}`);
					}
				}
				const next = newTarget(node.moduleSpecifier.text);
				if (next) replacement(node.moduleSpecifier.getStart(source), node.moduleSpecifier.end, JSON.stringify(next));
				return;
			}
			if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
				const arg = node.arguments?.[0];
				if (arg && ts.isStringLiteral(arg)) {
					const resolved = resolve(file, arg.text);
					const target = resolved && mapping.get(resolved);
					if (target && !isBackup(target)) {
						let relative = slash(path.relative(path.dirname(destination), target));
						if (!relative.startsWith('.')) relative = './' + relative;
						replacement(arg.getStart(source), arg.end, JSON.stringify(relative));
					}
				}
			}
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.getText(source).startsWith('import.meta.glob')
			)
				issue(destination, 'Review import.meta.glob patterns after folder relocation.');
			if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
			) {
				const arg = node.arguments[0];
				if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
					const target = resolve(file, arg.text);
					if (target && presenterNames.has(target))
						issue(destination, `Dynamic presenter import: use the new use{Name}Presenter export from ${arg.text}.`);
					const next = newTarget(arg.text);
					if (next) replacement(arg.getStart(source), arg.end, JSON.stringify(next));
				} else issue(destination, 'Computed import/require needs manual review.');
			}
			if (ts.isStringLiteral(node) && node.parent && ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)) {
				const next = newTarget(node.text);
				if (next) replacement(node.getStart(source), node.end, JSON.stringify(next));
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		let output = input;
		for (const edit of replacements.sort((a, b) => b.start - a.start))
			output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
		// Local style/asset references are filesystem links too; ordinary strings are not rewritten.
		output = output.replace(
			/((?:@use|@forward|@import)\s+|\b(?:src|href)\s*=\s*|\burl\(\s*)(['"])([^'"\n]+)\2/g,
			(whole, prefix: string, quote: string, value: string, offset: number) => {
				const resolved = resolve(file, value) ?? (/^@/.test(prefix) ? resolve(file, './' + value) : undefined);
				const target = resolved && (mapping.get(resolved) ?? resolved);
				if (!target || isBackup(target)) return whole;
				let relative = slash(path.relative(path.dirname(destination), target));
				if (!relative.startsWith('.')) relative = './' + relative;
				const oldNamespace = path
					.basename(value)
					.replace(/^_/, '')
					.replace(/\.(scss|sass|css)$/, '');
				const keepNamespace =
					prefix.startsWith('@use') && !/^\s+as\b/.test(output.slice(offset + whole.length)) && /^[A-Za-z_][\w-]*$/.test(oldNamespace);
				return prefix + quote + relative + quote + (keepNamespace ? ` as ${oldNamespace}` : '');
			}
		);
		return output;
	}
	for (const [file, bytes] of originals) {
		if (!file.startsWith(path.join(root, 'src') + path.sep)) continue;
		const to = mapping.get(file) ?? file;
		if (!mapping.size && !oldRoots.size && !upgradedSources.size) continue;
		const output =
			isBackup(to) || !textFile.test(file) ? bytes : Buffer.from(rewrite(file, to, upgradedSources.get(file) ?? bytes.toString()));
		if (writes.has(to) && path.basename(to) === 'index.ts') {
			const barrel = ts.createSourceFile(to, writes.get(to)!.toString() + '\n' + output.toString(), ts.ScriptTarget.Latest, true);
			writes.set(
				to,
				Buffer.from(
					[...new Set(barrel.statements.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, barrel)))].join('\n') +
						'\n'
				)
			);
		} else if (to !== file || !bytes.equals(output)) writes.set(to, output);
	}
	if (
		oldRoots.size ||
		mapping.size ||
		Object.entries(packageImports).some(
			([key, value]) => key.startsWith('#platform') && knownPlatformImport(value) && JSON.stringify(value).includes('./src/app/Platform')
		)
	) {
		workspaces.add('Shared');
		for (const folder of ['Contracts', 'Domain']) {
			const index = path.join(app, 'Contexts/SharedKernel', folder, 'index.ts');
			if (!writes.has(index) && !originals.has(index)) writes.set(index, Buffer.from('export {};\n'));
		}
		for (const workspace of workspaces)
			for (const folder of [
				'Scopes',
				'Ui/Actions',
				'Ui/Style',
				'Ui/Components/Scopes',
				'Ui/Components/Composite',
				'Ui/Components/Page',
				'Ui/Components/Core'
			]) {
				const index = path.join(app, 'Presentation', workspace, folder, 'index.ts');
				if (!writes.has(index) && !originals.has(index)) writes.set(index, Buffer.from('export {};\n'));
			}
		const packageFile = path.join(root, 'package.json');
		const json = JSON.parse(originals.get(packageFile)?.toString() ?? '{}');
		if (json.imports != null && (typeof json.imports !== 'object' || Array.isArray(json.imports)))
			throw new Error('Expected package.json imports object');
		const imports = { ...json.imports };
		const relocate = (value: unknown): unknown => {
			if (typeof value === 'string') return value.replace(/^\.\/src\/app\/Platform(?=\/|$)/, './src/platform');
			if (Array.isArray(value)) return value.map(relocate);
			if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
			return value;
		};
		// Upgrade a known old bare alias only when it already exists; never invent root barrels.
		const expectedImports: Record<string, unknown> = { ...PACKAGE_IMPORTS };
		if ('#platform' in imports) expectedImports['#platform'] = './src/platform/index.ts';
		for (const [key, expected] of Object.entries(expectedImports)) {
			const target = key.startsWith('#platform') ? relocate(expected) : expected;
			if (!(key in imports)) imports[key] = target;
			else if (key === '#platform' || key === '#platform/*') {
				if (knownPlatformImport(imports[key])) imports[key] = relocate(imports[key]);
				else issue(packageFile, `Custom package import ${key} retained; review relocated platform paths manually.`);
			} else if (!knownArchitectureImport(key, imports[key])) issue(packageFile, `Custom package import ${key} retained.`);
		}
		const content = Buffer.from(JSON.stringify({ ...json, imports }, null, '\t') + '\n');
		if (!originals.get(packageFile)?.equals(content)) writes.set(packageFile, content);
	}
	const configFile = [...originals.keys()].find((p) => /azure-net\.config\.[jt]s$/.test(p)) ?? path.join(root, 'azure-net.config.ts');
	const plannedSources = new Map<string, string>();
	for (const [file, bytes] of originals) {
		if (!file.startsWith(path.join(root, 'src') + path.sep) || !/\.(?:[jt]s|svelte)$/.test(file)) continue;
		const destination = mapping.get(file) ?? file;
		plannedSources.set(destination, (writes.get(destination) ?? bytes).toString());
	}
	const virtualResolve = (file: string, value: string): string | undefined => {
		let base = value.startsWith('.') ? path.resolve(path.dirname(file), value) : undefined;
		for (const [prefix, directory] of [
			['#platform', platform],
			['#contexts', path.join(app, 'Contexts')],
			['#presentation', path.join(app, 'Presentation')]
		] as const)
			if (value === prefix || value.startsWith(prefix + '/')) base = path.join(directory, value.slice(prefix.length));
		if (!base) return undefined;
		return [base, base + '.ts', base + '.js', base + '/index.ts', base + '/index.js', base.replace(/\.js$/, '.ts')].find((candidate) =>
			plannedSources.has(candidate)
		);
	};
	const layout = migratePresenterLayout(plannedSources, virtualResolve, specifier);
	for (const [file, content] of layout.updates) writes.set(file, Buffer.from(content));
	for (const problem of layout.issues) issue(problem.file, problem.reason);
	for (const [file, content] of new Map([...plannedSources, ...layout.updates]))
		if (/Presenter\.[jt]s$/.test(file) && /ReturnType<typeof \w*Provider>/.test(content))
			issue(
				file,
				'Use-case interface could not be proven from the provider graph; replace the retained ReturnType injection with the appropriate IUseCases contract manually.'
			);
	const config = migrateConfig(originals.get(configFile)?.toString() ?? 'export default {};', oldRoots.size ? [...workspaces].sort() : []);
	for (const reason of config.issues) issue(configFile, reason);
	if (config.content !== originals.get(configFile)?.toString() && (originals.has(configFile) || oldRoots.size))
		writes.set(configFile, Buffer.from(config.content));
	const tsconfig = path.join(root, 'tsconfig.json');
	if ((oldRoots.size || issues.length) && originals.has(tsconfig)) {
		const parsed = ts.parseConfigFileTextToJson(tsconfig, originals.get(tsconfig)!.toString());
		if (parsed.error) throw new Error('Cannot parse tsconfig.json safely.');
		const exclude = parsed.config.exclude ?? ['node_modules', 'bower_components', 'jspm_packages'];
		parsed.config.exclude = [...new Set([...exclude, 'src/app/.backup/**'])];
		writes.set(tsconfig, Buffer.from(JSON.stringify(parsed.config, null, '\t') + '\n'));
	}

	const moves = [...mapping].map(([from, to]) => ({ from, to }));
	for (const item of issues) {
		const source = originals.has(item.file) ? item.file : [...mapping].find(([, to]) => to === item.file)?.[0];
		if (source) {
			const relative = source.startsWith(app + path.sep) ? path.relative(app, source) : path.join('_project', path.relative(root, source));
			const copy = path.join(app, '.backup', relative);
			if (!writes.has(copy)) writes.set(copy, originals.get(source)!);
		}
		item.file = mapping.get(item.file) ?? item.file;
	}
	if (issues.length) writes.set(path.join(app, '.backup/MigrationIssues.json'), Buffer.from(JSON.stringify(issues, null, 2) + '\n'));
	// Repeated runs reuse identical archives and never overwrite different original bytes.
	for (const [target, bytes] of [...writes]) {
		if (!isBackup(target)) {
			if (originals.get(target)?.equals(bytes)) writes.delete(target);
			continue;
		}
		let candidate = target;
		let version = 0;
		while (true) {
			await assertSafeTarget(root, candidate);
			try {
				const existing = await fs.readFile(candidate);
				originals.set(candidate, existing);
				if (existing.equals(bytes)) {
					writes.delete(target);
					break;
				}
				candidate = target + '.' + createHash('sha256').update(bytes).digest('hex').slice(0, 12) + (version++ ? '.' + version : '');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				if (candidate !== target) {
					writes.delete(target);
					writes.set(candidate, bytes);
				}
				break;
			}
		}
	}
	if (!mapping.size && !writes.size && !issues.length) throw new Error('Nothing to migrate.');
	return {
		root,
		moves,
		issues,
		writes,
		originals,
		removes: [...mapping].filter(([, to]) => !isBackup(to)).map(([from]) => from),
		workspaces: [...workspaces]
	};
}

export async function applyMigration(plan: MigrationPlan): Promise<string> {
	// Verify the plan before creating any backup or touching user files.
	for (const file of new Set([...plan.originals.keys(), ...plan.writes.keys(), ...plan.removes])) await assertSafeTarget(plan.root, file);
	await assertSafeTarget(plan.root, path.join(plan.root, '.azure-net/migrations'));
	for (const file of await files(path.join(plan.root, 'src')))
		if (!plan.originals.has(file)) throw new Error(`New source file since planning: ${file}`);
	for (const [file, bytes] of plan.originals)
		if (!(await fs.readFile(file)).equals(bytes)) throw new Error(`File changed since planning: ${file}`);
	for (const target of plan.writes.keys())
		if (!plan.originals.has(target)) {
			try {
				await fs.access(target);
				throw new Error(`Migration target already exists: ${target}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
	const snapshot = await fs.mkdtemp(
		path.join(
			await fs
				.mkdir(path.join(plan.root, '.azure-net/migrations'), { recursive: true })
				.then(() => path.join(plan.root, '.azure-net/migrations')),
			'migration-'
		)
	);
	const touched = new Set([...plan.removes, ...plan.writes.keys()]);
	for (const file of touched)
		if (plan.originals.has(file)) {
			const target = path.join(snapshot, 'original', path.relative(plan.root, file));
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, plan.originals.get(file)!);
		}
	await fs.writeFile(
		path.join(snapshot, 'manifest.json'),
		JSON.stringify(
			{
				moves: plan.moves,
				generated: [...plan.writes.keys()].filter((p) => !plan.originals.has(p)),
				issues: plan.issues,
				hashes: [...touched]
					.filter((p) => plan.originals.has(p))
					.map((p) => ({ file: p, sha256: createHash('sha256').update(plan.originals.get(p)!).digest('hex') }))
			},
			null,
			2
		)
	);
	const report = path.join(snapshot, 'Report.md');
	await fs.writeFile(
		report,
		`# Migration report\n\n${plan.moves.length} files classified. Original bytes: ./original. Unknown files: src/app/.backup.\n\nRecognized presenter factories are converted to classes with scoped RegisterProvider accessors. Closure state is preserved. Async helpers are imported directly. Review unsupported factories and lifecycle requirements. Run azure-net check internal and your package manager's check/build.\n\n## Review\n${plan.issues.map((i) => `- [${slash(path.relative(plan.root, i.file))}](${i.file}): ${i.reason}`).join('\n')}\n\n## Moves\n${plan.moves.map((m) => `- ${slash(path.relative(plan.root, m.from))} -> [${slash(path.relative(plan.root, m.to))}](${m.to})`).join('\n')}\n`
	);
	try {
		for (const [file, bytes] of plan.writes) {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, bytes);
		}
		for (const file of plan.removes) if (!plan.writes.has(file)) await fs.unlink(file);
	} catch (error) {
		for (const file of touched) {
			const original = plan.originals.get(file);
			if (original) {
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.writeFile(file, original);
			} else await fs.rm(file, { force: true });
		}
		throw new Error(`Migration rolled back after I/O failure. Snapshot: ${snapshot}`, { cause: error });
	}
	async function removeEmpty(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true }))
			if (entry.isDirectory() && entry.name !== '.backup') await removeEmpty(path.join(dir, entry.name));
		if (!(await fs.readdir(dir)).length) await fs.rmdir(dir);
	}
	try {
		await removeEmpty(path.join(plan.root, 'src/app'));
	} catch (error) {
		console.warn(`Files migrated, but empty directory cleanup failed: ${String(error)}`);
	}

	return report;
}

export default async function migrate(options: { dryRun?: boolean; yes?: boolean } = {}): Promise<void> {
	const plan = await planMigration();
	console.log(`Migration plan: ${plan.moves.length} files, ${plan.workspaces.length} workspaces, ${plan.issues.length} review items.`);
	for (const move of plan.moves) console.log(`${path.relative(plan.root, move.from)} -> ${path.relative(plan.root, move.to)}`);
	if (options.dryRun) {
		for (const issue of plan.issues) console.warn(`${issue.file}: ${issue.reason}`);
		return;
	}
	if (!options.yes) {
		const answer = await prompts({
			type: 'confirm',
			name: 'apply',
			initial: false,
			message: 'Apply migration? Original files will be backed up; review/check/build is required afterwards.'
		});
		if (!answer.apply) return;
	}
	const report = await applyMigration(plan);
	console.log(`Migration complete. Review report: ${report}`);
	for (const issue of plan.issues) console.warn(`${issue.file}: ${issue.reason}`);
}
