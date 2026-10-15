import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import prompts from 'prompts';
import { CONTEXT_DIRS, normalizePascalName } from '../utils/architecture.js';
import { VITE_CONFIGS } from '../utils/viteConfig.js';
import { mergePackageImports, resolvePackageImport } from '../utils/packageImports.js';
import { flattenConfigLiterals } from '../utils/flattenConfig.js';
import { parseSource } from '../checks/architecture.js';
import { migrateAsyncHelpers, migratePresenterSource } from './presenters.js';
const slash = (s) => s.split(path.sep).join('/');
const textFile = /\.(?:[cm]?[jt]sx?|svelte|css|scss|sass|less|json|html|svg)$/;
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const unwrap = (n) => (ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n);
const propName = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined);
async function files(root) {
    const out = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (['.backup', '.git', 'node_modules', '.svelte-kit'].includes(entry.name))
            continue;
        const file = path.join(root, entry.name);
        if (entry.isSymbolicLink())
            throw new Error(`Migration refuses symbolic links in source: ${file}`);
        if (entry.isDirectory())
            out.push(...(await files(file)));
        else
            out.push(file);
    }
    return out.sort();
}
function pascalFile(file) {
    if (file === 'index.ts' || file === 'index.js')
        return file;
    const dot = file.indexOf('.');
    const stem = (dot < 0 ? file : file.slice(0, dot)).replace(/^_(?=.*)/, '');
    return normalizePascalName(stem) + (dot < 0 ? '' : file.slice(dot));
}
function partsPath(parts) {
    return parts.map((p, i) => (i === parts.length - 1 ? pascalFile(p) : normalizePascalName(p))).join('/');
}
export async function planMigration(root = process.cwd()) {
    root = path.resolve(root);
    const app = path.join(root, 'src/app');
    const originals = new Map();
    for (const file of await files(path.join(root, 'src')))
        originals.set(file, await fs.readFile(file));
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
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const issues = [];
    const issueKeys = new Set();
    const issue = (file, reason) => {
        const key = file + reason;
        if (!issueKeys.has(key)) {
            issueKeys.add(key);
            issues.push({ file, reason });
        }
    };
    const mapping = new Map();
    const workspaces = new Set();
    const contexts = new Set(['SharedKernel']);
    const aliases = new Map([
        ['$lib', path.join(root, 'src/lib')],
        ['$program', path.join(root, 'src/program.ts')]
    ]);
    const oldRoots = new Set();
    for (const file of originals.keys()) {
        const relative = slash(path.relative(app, file));
        if (relative.startsWith('../'))
            continue;
        const first = relative.split('/')[0];
        if (!['Contexts', 'Presentation', 'Platform'].includes(first))
            oldRoots.add(first);
    }
    for (const folder of oldRoots)
        aliases.set(`$${folder}`, path.join(app, folder));
    const svelteConfig = [...originals.keys()].find((p) => /svelte\.config\.(?:js|ts|mjs)$/.test(p));
    const viteConfig = [...originals.keys()].find((p) => VITE_CONFIGS.includes(path.basename(p)));
    const configPath = svelteConfig ?? viteConfig;
    const configAst = ts.createSourceFile(configPath ?? 'config.ts', configPath ? originals.get(configPath).toString() : '', ts.ScriptTarget.Latest, true);
    const packageImports = JSON.parse(originals.get(path.join(root, 'package.json'))?.toString() ?? '{}').imports ?? {};
    const readAliases = (node) => {
        if (ts.isPropertyAssignment(node) && propName(node.name) === 'alias' && ts.isObjectLiteralExpression(node.initializer)) {
            for (const p of node.initializer.properties)
                if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) {
                    const name = propName(p.name);
                    if (name)
                        aliases.set(name, path.resolve(root, p.initializer.text));
                }
        }
        ts.forEachChild(node, readAliases);
    };
    readAliases(configAst);
    if (viteConfig && svelteConfig)
        readAliases(ts.createSourceFile(viteConfig, originals.get(viteConfig).toString(), ts.ScriptTarget.Latest, true));
    function resolve(from, specifier) {
        const clean = specifier[0] + specifier.slice(1).split(/[?#]/)[0];
        let base;
        if (clean.startsWith('.'))
            base = path.resolve(path.dirname(from), clean);
        else if (clean.startsWith('#'))
            base = resolvePackageImport(packageImports, clean, root) ?? undefined;
        else
            for (const [alias, target] of [...aliases].sort((a, b) => b[0].length - a[0].length)) {
                if (clean === alias || clean.startsWith(alias + '/')) {
                    base = path.join(target, clean.slice(alias.length));
                    break;
                }
            }
        if (!base)
            return undefined;
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
            if (originals.has(candidate))
                return candidate;
        }
        return undefined;
    }
    const domains = new Map();
    for (const file of originals.keys()) {
        const m = slash(path.relative(app, file)).match(/^([^/]+)\/layers\/domain\/([^/]+)\//);
        if (m) {
            const names = domains.get(m[1]) ?? new Set();
            names.add(m[2]);
            domains.set(m[1], names);
        }
    }
    const backup = (file, why) => {
        issue(file, why);
        return path.join(app, '.backup', path.relative(app, file));
    };
    for (const file of originals.keys()) {
        const rel = slash(path.relative(app, file));
        const p = rel.split('/');
        if (!oldRoots.has(p[0]))
            continue;
        const area = p[0];
        const workspace = /^(shared-kernel|shared)$/i.test(area) ? 'Shared' : normalizePascalName(area);
        let dest;
        try {
            if (p[1] === 'ui') {
                workspaces.add(workspace);
                dest = `Presentation/${workspace}/Ui/${partsPath(p.slice(2))}`;
            }
            else if (p[1] === 'layers' && p[2] === 'presentation') {
                workspaces.add(workspace);
                dest = `Presentation/${workspace}/Scopes/${partsPath(p.slice(3))}`;
            }
            else if (p[1] === 'layers' && p[2] === 'domain' && p.length >= 5) {
                const context = normalizePascalName(p[3]);
                contexts.add(context);
                const folders = { model: 'Entities', models: 'Entities', ports: 'Ports', enums: 'Enums', enum: 'Enums' };
                const rest = [...p.slice(4)];
                if (folders[rest[0]])
                    rest[0] = folders[rest[0]];
                dest = `Contexts/${context}/Domain/${partsPath(rest)}`;
                if (/\/I[A-Z][^/]*\.ts$/.test(dest))
                    dest = dest.replace(/\/I([A-Z][^/]*)\.ts$/, '/$1.ts');
            }
            else if (p[1] === 'layers' &&
                (p.includes('repositories') || p.includes('repositores') || p.includes('use-cases')) &&
                !/^index\./.test(p.at(-1))) {
                const base = path.basename(file).replace(/(?:Repository|UseCases?)\.[^.]+$/, '');
                const match = [...(domains.get(area) ?? [])].filter((d) => normalizePascalName(d) === base);
                if (match.length === 1) {
                    contexts.add(base);
                    dest = `Contexts/${base}/${p.includes('use-cases') ? 'Application/UseCases' : 'Infrastructure/Repositories'}/${pascalFile(p.at(-1))}`;
                }
            }
            else if (p[1] === 'runtime')
                dest = `Platform/Bootstrap/${partsPath(p.slice(p[2] === 'bootstrap' ? 3 : 2))}`;
            else if (['essentials', 'internal'].includes(p[1])) {
                if (p[2] === 'foundation') {
                    const rest = p.slice(p[3] === 'constructs' ? 4 : 3);
                    if (rest[0] !== 'provider' && rest[0] !== 'providers')
                        dest = `Platform/Foundation/${partsPath(rest)}`;
                }
                else if (p[2] === 'localization' || p[2] === 'pipelines')
                    dest = `Platform/Bootstrap/${partsPath(p.slice(2))}`;
                else if (p[2] === 'config')
                    dest = `Platform/Foundation/${partsPath(p.slice(2))}`;
            }
        }
        catch {
            /* Invalid names are archived instead of guessed. */
        }
        mapping.set(file, dest ? path.join(app, dest) : backup(file, 'No unambiguous target (legacy provider, aggregate barrel, or unsupported folder).'));
    }
    // No last-writer wins: preserve every conflicting file for manual resolution.
    const destinations = new Map();
    for (const [from, to] of mapping) {
        const key = to.toLowerCase();
        const list = destinations.get(key) ?? [];
        list.push(from);
        destinations.set(key, list);
    }
    for (const list of destinations.values()) {
        const target = mapping.get(list[0]);
        if (target.includes(`${path.sep}.backup${path.sep}`))
            continue;
        if (list.length > 1 || (originals.has(target) && !mapping.has(target))) {
            // Domain barrels are safely reconstituted later from each original export list.
            if (list.length > 1 &&
                path.basename(target) === 'index.ts' &&
                !originals.has(target) &&
                list.every((file) => ts.createSourceFile(file, originals.get(file).toString(), ts.ScriptTarget.Latest, true).statements.every(ts.isExportDeclaration)))
                continue;
            for (const file of list)
                mapping.set(file, backup(file, `Target collision: ${target}; no file overwritten.`));
        }
    }
    const isBackup = (file) => file.includes(`${path.sep}.backup${path.sep}`);
    function specifier(to, from) {
        const relative = slash(path.relative(app, to));
        let value;
        const first = relative.split('/')[0];
        const prefix = { Contexts: '#contexts', Presentation: '#presentation', Platform: '#platform' };
        if (prefix[first])
            value = prefix[first] + relative.slice(first.length);
        else {
            value = slash(path.relative(path.dirname(from), to));
            if (!value.startsWith('.'))
                value = './' + value;
        }
        return value.replace(/\.(?:ts|js)$/, '').replace(/\/index$/, '');
    }
    function exportedSymbol(file, name, seen = new Set()) {
        const key = `${file}:${name}`;
        if (seen.has(key))
            return undefined;
        seen.add(key);
        if (file.endsWith('.svelte') && name === 'default')
            return { file, name };
        const source = parseSource(originals.get(file)?.toString() ?? '', file);
        for (const statement of source.statements) {
            if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
                const target = resolve(file, statement.moduleSpecifier.text);
                if (!target)
                    continue;
                if (!statement.exportClause) {
                    const found = exportedSymbol(target, name, seen);
                    if (found)
                        return found;
                }
                else if (ts.isNamedExports(statement.exportClause))
                    for (const element of statement.exportClause.elements) {
                        if (element.name.text === name)
                            return (exportedSymbol(target, element.propertyName?.text ?? name, seen) ?? {
                                file: target,
                                name: element.propertyName?.text ?? name
                            });
                    }
            }
            else {
                if (name === 'default' && ts.isExportAssignment(statement))
                    return { file, name };
                if ('name' in statement && propName(statement.name) === name)
                    return { file, name };
                if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => propName(d.name) === name))
                    return { file, name };
            }
        }
        return undefined;
    }
    const presenterNames = new Map();
    const upgradedSources = new Map();
    const factorySymbols = new Map();
    for (const [file, bytes] of originals) {
        if (!/\.[jt]s$/.test(file))
            continue;
        const source = parseSource(bytes.toString(), file);
        const creators = new Set();
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                !['@azure-net/kit/delivery', '@azure-net/edges'].includes(statement.moduleSpecifier.text))
                continue;
            const bindings = statement.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings))
                for (const binding of bindings.elements)
                    if ((binding.propertyName ?? binding.name).text === 'createPresenterFactory')
                        creators.add(binding.name.text);
        }
        const names = new Set();
        for (const statement of source.statements) {
            if (!ts.isVariableStatement(statement))
                continue;
            for (const declaration of statement.declarationList.declarations) {
                const init = declaration.initializer;
                if (ts.isIdentifier(declaration.name) &&
                    init &&
                    ts.isCallExpression(init) &&
                    ts.isIdentifier(init.expression) &&
                    creators.has(init.expression.text))
                    names.add(declaration.name.text);
            }
        }
        if (names.size)
            factorySymbols.set(file, names);
    }
    for (const [file, bytes] of originals) {
        if (!file.startsWith(path.join(root, 'src') + path.sep) || !/\.(?:ts|js|svelte)$/.test(file))
            continue;
        if (mapping.has(file) && isBackup(mapping.get(file)))
            continue;
        const source = parseSource(bytes.toString(), file);
        const factories = new Set();
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
                continue;
            const bindings = statement.importClause?.namedBindings;
            if (!bindings || !ts.isNamedImports(bindings))
                continue;
            for (const binding of bindings.elements) {
                const name = (binding.propertyName ?? binding.name).text;
                const target = resolve(file, statement.moduleSpecifier.text);
                const symbol = target && exportedSymbol(target, name);
                if ((!target &&
                    name === 'createPresenter' &&
                    ['@azure-net/kit/delivery', '@azure-net/edges'].includes(statement.moduleSpecifier.text)) ||
                    (symbol && factorySymbols.get(symbol.file)?.has(symbol.name)))
                    factories.add(binding.name.text);
            }
        }
        const result = file.endsWith('.svelte')
            ? { content: bytes.toString(), converted: new Map(), issues: [] }
            : migratePresenterSource(bytes.toString(), file, factories);
        if (result.converted.size)
            presenterNames.set(file, result.converted);
        for (const reason of result.issues)
            issue(file, reason);
        let upgraded = result.content;
        try {
            upgraded = migrateAsyncHelpers(upgraded, file);
        }
        catch (error) {
            issue(file, `Async helpers need manual migration: ${String(error)}`);
        }
        if (upgraded !== bytes.toString())
            upgradedSources.set(file, upgraded);
    }
    const providers = new Map();
    for (const [file, bytes] of originals)
        if (/Provider\.[jt]s$/.test(file) && mapping.has(file)) {
            const source = parseSource(bytes.toString(), file);
            const imports = new Map();
            for (const s of source.statements)
                if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
                    const target = resolve(file, s.moduleSpecifier.text);
                    if (s.importClause?.name)
                        imports.set(s.importClause.name.text, { file: target, source: s.moduleSpecifier.text, exported: 'default' });
                    const bindings = s.importClause?.namedBindings;
                    if (bindings && ts.isNamedImports(bindings))
                        for (const e of bindings.elements)
                            imports.set(e.name.text, {
                                file: target && (exportedSymbol(target, e.propertyName?.text ?? e.name.text)?.file ?? target),
                                source: s.moduleSpecifier.text,
                                exported: (target && exportedSymbol(target, e.propertyName?.text ?? e.name.text)?.name) || e.propertyName?.text || e.name.text
                            });
                }
            for (const statement of source.statements)
                if (ts.isVariableStatement(statement))
                    for (const d of statement.declarationList.declarations) {
                        if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isCallExpression(d.initializer))
                            continue;
                        if (!ts.isIdentifier(d.initializer.expression) ||
                            !['createBoundaryProvider', 'CreateDiContainer'].includes(imports.get(d.initializer.expression.text)?.exported ?? ''))
                            continue;
                        if (source.statements.some((s) => ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamespaceImport(s.importClause.namedBindings))) {
                            issue(file, 'Namespace imports in a provider require manual DI migration.');
                            continue;
                        }
                        const settings = d.initializer.arguments[1];
                        if (!settings || !ts.isObjectLiteralExpression(settings))
                            continue;
                        const register = settings.properties.find((p) => propName(p.name) === 'register');
                        if (!register || !ts.isPropertyAssignment(register) || !ts.isArrowFunction(register.initializer))
                            continue;
                        const body = register.initializer.body;
                        if (ts.isBlock(body)) {
                            issue(file, 'Custom block register requires manual DI migration.');
                            continue;
                        }
                        const values = unwrap(body);
                        if (!ts.isObjectLiteralExpression(values))
                            continue;
                        if (settings.properties.some((p) => !['dependsOn', 'register'].includes(propName(p.name) ?? ''))) {
                            issue(file, 'Provider has custom settings/boot; not inlined.');
                            continue;
                        }
                        if (source.statements.some((s) => !ts.isImportDeclaration(s) && s !== statement && !ts.isEmptyStatement(s))) {
                            issue(file, 'Provider has extra module declarations; manual migration required.');
                            continue;
                        }
                        providers.set(d.name.text, { file, name: d.name.text, source, settings, values, imports });
                    }
        }
    const diFile = path.join(app, 'Platform/Foundation/DI/ApplicationProvider.ts');
    const diImports = new Set(["import { CreateDiContainer } from '@azure-net/kit';"]);
    const expressions = new Map();
    const locals = [];
    const cached = new Map();
    const active = new Set();
    let counter = 0;
    function expand(provider, key) {
        const id = `${provider.name}.${key}`;
        if (cached.has(id))
            return cached.get(id);
        if (active.has(id))
            throw new Error(`Circular DI: ${id}`);
        active.add(id);
        const property = provider.values.properties.find((p) => propName(p.name) === key);
        if (!property ||
            !ts.isPropertyAssignment(property) ||
            !ts.isArrowFunction(property.initializer) ||
            property.initializer.parameters.length ||
            ts.isBlock(property.initializer.body))
            throw new Error(`Unsupported factory ${id}`);
        const expression = property.initializer.body;
        const result = ts.transform(expression, [
            (context) => {
                const visit = (node) => {
                    if (ts.isShorthandPropertyAssignment(node) && provider.imports.has(node.name.text)) {
                        const visited = visit(node.name);
                        const imported = provider.imports.get(node.name.text);
                        if (!providers.has(imported.exported))
                            return ts.factory.createPropertyAssignment(node.name.text, ts.factory.createIdentifier(`M${[...providers.keys()].indexOf(provider.name)}_${visited.text}`));
                    }
                    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
                        const imported = provider.imports.get(node.expression.text);
                        const dep = providers.get(imported?.exported ?? node.expression.text);
                        if (dep)
                            return ts.factory.createCallExpression(ts.factory.createIdentifier(expand(dep, node.name.text)), undefined, []);
                    }
                    if (ts.isIdentifier(node) &&
                        !(node.parent &&
                            ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
                                (ts.isPropertyAssignment(node.parent) && node.parent.name === node)))) {
                        const imported = provider.imports.get(node.text);
                        if (imported &&
                            !providers.has(imported.exported) &&
                            !['createBoundaryProvider', 'CreateDiContainer'].includes(imported.exported)) {
                            const to = imported.file && mapping.get(imported.file);
                            if (to && isBackup(to))
                                throw new Error(`Dependency is archived: ${imported.file}`);
                            const local = `M${[...providers.keys()].indexOf(provider.name)}_${node.text}`;
                            const source = imported.file ? specifier(to ?? imported.file, diFile) : imported.source;
                            diImports.add(imported.exported === 'default'
                                ? `import ${local} from ${JSON.stringify(source)};`
                                : `import { ${imported.exported} as ${local} } from ${JSON.stringify(source)};`);
                            if (node.parent && ts.isShorthandPropertyAssignment(node.parent))
                                return node;
                            return ts.factory.createIdentifier(local);
                        }
                    }
                    return ts.visitEachChild(node, visit, context);
                };
                return (node) => ts.visitNode(node, visit);
            }
        ]);
        const code = printer.printNode(ts.EmitHint.Expression, result.transformed[0], provider.source);
        result.dispose();
        expressions.set(id, code);
        const local = `get${++counter}_${key}`;
        // Private lazy getters preserve original per-service sharing without nested providers.
        if (/DatasourceProvider$/.test(provider.name)) {
            locals.push(`const datasource${counter} = ${code};\nconst ${local} = () => datasource${counter};`);
        }
        else if (!/ApplicationProvider$/.test(provider.name))
            locals.push(`const ${local} = (() => {\nlet initialized = false;\nlet value: ReturnType<typeof create>;\nconst create = () => (${code});\nreturn () => { if (!initialized) { value = create(); initialized = true; } return value; };\n})();`);
        cached.set(id, local);
        active.delete(id);
        return local;
    }
    const publicServices = new Map();
    const converted = new Set();
    for (const provider of providers.values())
        if (/ApplicationProvider$/.test(provider.name)) {
            const checkpoint = {
                locals: locals.length,
                counter,
                cached: new Map(cached),
                expressions: new Map(expressions),
                imports: new Set(diImports)
            };
            try {
                const entries = [];
                for (const property of provider.values.properties) {
                    const key = propName(property.name);
                    if (!key || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key))
                        throw new Error('Unsupported service key');
                    if (publicServices.has(key))
                        throw new Error(`Duplicate application service ${key}`);
                    expand(provider, key);
                    entries.push([key, `() => (${expressions.get(`${provider.name}.${key}`)})`]);
                }
                for (const [key, value] of entries)
                    publicServices.set(key, value);
                converted.add(provider.name);
            }
            catch (error) {
                locals.length = checkpoint.locals;
                counter = checkpoint.counter;
                cached.clear();
                for (const [key, value] of checkpoint.cached)
                    cached.set(key, value);
                expressions.clear();
                for (const [key, value] of checkpoint.expressions)
                    expressions.set(key, value);
                diImports.clear();
                for (const value of checkpoint.imports)
                    diImports.add(value);
                active.clear();
                issue(provider.file, `DI not migrated: ${String(error)}`);
            }
        }
    const writes = new Map();
    const replacements = [];
    function namespacePresenterName(file, name, seen = new Set()) {
        if (seen.has(file))
            return undefined;
        seen.add(file);
        const direct = presenterNames.get(file)?.get(name);
        if (direct)
            return direct;
        const source = parseSource(originals.get(file)?.toString() ?? '', file);
        for (const statement of source.statements) {
            if (!ts.isExportDeclaration(statement))
                continue;
            // Named exports keep their public alias when rewritten below.
            if (statement.exportClause &&
                ts.isNamedExports(statement.exportClause) &&
                statement.exportClause.elements.some((entry) => entry.name.text === name))
                return name;
        }
        for (const statement of source.statements) {
            if (!ts.isExportDeclaration(statement) ||
                statement.exportClause ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier))
                continue;
            const target = resolve(file, statement.moduleSpecifier.text);
            const renamed = target && namespacePresenterName(target, name, seen);
            if (renamed)
                return renamed;
        }
        return undefined;
    }
    function rewrite(file, destination, input) {
        replacements.length = 0;
        const source = parseSource(input, file);
        const namespaces = new Map();
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
                continue;
            const bindings = statement.importClause?.namedBindings;
            const target = resolve(file, statement.moduleSpecifier.text);
            if (target && bindings && ts.isNamespaceImport(bindings))
                namespaces.set(bindings.name.text, target);
        }
        const replacement = (start, end, text) => {
            replacements.push({ start, end, text });
        };
        const checkBoundary = (to) => {
            const a = slash(path.relative(app, destination)).split('/'), b = slash(path.relative(app, to)).split('/');
            if (a[0] === 'Contexts' && b[0] === 'Contexts' && a[1] !== b[1] && b[1] !== 'SharedKernel')
                issue(destination, `Review cross-context dependency on ${to}; not moved into SharedKernel automatically.`);
            if (a[0] === 'Presentation' && b[0] === 'Presentation' && a[1] !== b[1] && b[1] !== 'Shared')
                issue(destination, `Review cross-workspace dependency on ${to}.`);
        };
        const newTarget = (value) => {
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
        const visit = (node) => {
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
                const target = namespaces.get(node.expression.text);
                const name = target && namespacePresenterName(target, node.name.text);
                if (name)
                    replacement(node.name.getStart(source), node.name.end, name);
            }
            if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
                const target = namespaces.get(node.expression.text);
                const name = target && namespacePresenterName(target, node.argumentExpression.text);
                if (name)
                    replacement(node.argumentExpression.getStart(source), node.argumentExpression.end, JSON.stringify(name));
            }
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                const target = resolve(file, node.moduleSpecifier.text);
                const bindings = node.importClause?.namedBindings;
                if (target && bindings && ts.isNamedImports(bindings) && !node.importClause?.name) {
                    const groups = new Map();
                    for (const e of bindings.elements) {
                        const name = e.propertyName?.text ?? e.name.text;
                        const symbol = exportedSymbol(target, name);
                        const declared = symbol?.file ?? target;
                        const to = mapping.get(declared) ?? declared;
                        const isProvider = converted.has(name) && providers.get(name)?.file === declared;
                        const spec = isProvider ? '#platform/Foundation/DI' : isBackup(to) ? undefined : specifier(to, destination);
                        if (!spec) {
                            issue(destination, `Unresolved imported symbol ${name} from ${node.moduleSpecifier.text}`);
                            continue;
                        }
                        checkBoundary(to);
                        const imported = isProvider
                            ? 'ApplicationProvider'
                            : (presenterNames.get(declared)?.get(symbol?.name ?? name) ?? symbol?.name ?? name);
                        const parts = groups.get(spec) ?? [];
                        parts.push(`${!node.importClause?.isTypeOnly && e.isTypeOnly ? 'type ' : ''}${imported}${imported === e.name.text ? '' : ` as ${e.name.text}`}`);
                        groups.set(spec, parts);
                    }
                    if ([...groups.values()].reduce((n, g) => n + g.length, 0) === bindings.elements.length) {
                        replacement(node.getStart(source), node.end, [...groups]
                            .map(([spec, names]) => `import ${node.importClause?.isTypeOnly ? 'type ' : ''}{ ${names.join(', ')} } from ${JSON.stringify(spec)};`)
                            .join('\n'));
                        return;
                    }
                }
                const next = newTarget(node.moduleSpecifier.text);
                if (next)
                    replacement(node.moduleSpecifier.getStart(source), node.moduleSpecifier.end, JSON.stringify(next));
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
                if (next)
                    replacement(node.moduleSpecifier.getStart(source), node.moduleSpecifier.end, JSON.stringify(next));
                return;
            }
            if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
                const arg = node.arguments?.[0];
                if (arg && ts.isStringLiteral(arg)) {
                    const resolved = resolve(file, arg.text);
                    const target = resolved && mapping.get(resolved);
                    if (target && !isBackup(target)) {
                        let relative = slash(path.relative(path.dirname(destination), target));
                        if (!relative.startsWith('.'))
                            relative = './' + relative;
                        replacement(arg.getStart(source), arg.end, JSON.stringify(relative));
                    }
                }
            }
            if (ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.getText(source).startsWith('import.meta.glob'))
                issue(destination, 'Review import.meta.glob patterns after folder relocation.');
            if (ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                const arg = node.arguments[0];
                if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
                    const target = resolve(file, arg.text);
                    if (target && presenterNames.has(target))
                        issue(destination, `Dynamic presenter import: use the new use{Name}Presenter export from ${arg.text}.`);
                    const next = newTarget(arg.text);
                    if (next)
                        replacement(arg.getStart(source), arg.end, JSON.stringify(next));
                }
                else
                    issue(destination, 'Computed import/require needs manual review.');
            }
            if (ts.isStringLiteral(node) && node.parent && ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)) {
                const next = newTarget(node.text);
                if (next)
                    replacement(node.getStart(source), node.end, JSON.stringify(next));
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        let output = input;
        for (const edit of replacements.sort((a, b) => b.start - a.start))
            output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
        // Local style/asset references are filesystem links too; ordinary strings are not rewritten.
        output = output.replace(/((?:@use|@forward|@import)\s+|\b(?:src|href)\s*=\s*|\burl\(\s*)(['"])([^'"\n]+)\2/g, (whole, prefix, quote, value, offset) => {
            const resolved = resolve(file, value) ?? (/^@/.test(prefix) ? resolve(file, './' + value) : undefined);
            const target = resolved && (mapping.get(resolved) ?? resolved);
            if (!target || isBackup(target))
                return whole;
            let relative = slash(path.relative(path.dirname(destination), target));
            if (!relative.startsWith('.'))
                relative = './' + relative;
            const oldNamespace = path
                .basename(value)
                .replace(/^_/, '')
                .replace(/\.(scss|sass|css)$/, '');
            const keepNamespace = prefix.startsWith('@use') && !/^\s+as\b/.test(output.slice(offset + whole.length)) && /^[A-Za-z_][\w-]*$/.test(oldNamespace);
            return prefix + quote + relative + quote + (keepNamespace ? ` as ${oldNamespace}` : '');
        });
        return output;
    }
    for (const [file, bytes] of originals) {
        if (!file.startsWith(path.join(root, 'src') + path.sep))
            continue;
        const to = mapping.get(file) ?? file;
        const output = isBackup(to) || !textFile.test(file) ? bytes : Buffer.from(rewrite(file, to, upgradedSources.get(file) ?? bytes.toString()));
        if (writes.has(to) && path.basename(to) === 'index.ts') {
            const barrel = ts.createSourceFile(to, writes.get(to).toString() + '\n' + output.toString(), ts.ScriptTarget.Latest, true);
            writes.set(to, Buffer.from([...new Set(barrel.statements.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, barrel)))].join('\n') +
                '\n'));
        }
        else if (to !== file || !bytes.equals(output))
            writes.set(to, output);
    }
    if (oldRoots.size) {
        if (originals.has(diFile))
            throw new Error(`Refusing to overwrite existing ${diFile}`);
        writes.set(diFile, Buffer.from(`${[...diImports].join('\n')}\n\nexport const ApplicationProvider = CreateDiContainer('ApplicationProvider', {\nregister: () => {\n${locals.join('\n')}\nreturn {\n${[...publicServices].map(([name, getter]) => `${name}: ${getter}`).join(',\n')}\n};\n}\n});\n`));
        writes.set(path.join(path.dirname(diFile), 'index.ts'), Buffer.from("export * from './ApplicationProvider';\n"));
        workspaces.add('Shared');
        for (const context of contexts)
            for (const folder of CONTEXT_DIRS) {
                const index = path.join(app, 'Contexts', context, folder, 'index.ts');
                if (!writes.has(index) && !originals.has(index))
                    writes.set(index, Buffer.from('export {};\n'));
            }
        for (const workspace of workspaces)
            for (const folder of ['Ui', 'Scopes', 'Shell']) {
                const index = path.join(app, 'Presentation', workspace, folder, 'index.ts');
                if (!writes.has(index) && !originals.has(index))
                    writes.set(index, Buffer.from('export {};\n'));
            }
        const packageFile = path.join(root, 'package.json');
        writes.set(packageFile, Buffer.from(await mergePackageImports(originals.get(packageFile)?.toString() ?? '{}')));
    }
    const configFile = [...originals.keys()].find((p) => /azure-net\.config\.[jt]s$/.test(p)) ?? path.join(root, 'azure-net.config.ts');
    let config = flattenConfigLiterals(originals.get(configFile)?.toString() ?? 'export default {};');
    const configSource = ts.createSourceFile(configFile, config, ts.ScriptTarget.Latest, true);
    const exported = configSource.statements.find(ts.isExportAssignment);
    if (!exported || !ts.isObjectLiteralExpression(exported.expression))
        throw new Error('Migration requires an object-literal default config; normalize it first.');
    const kept = exported.expression.properties.filter((p) => !['defaultPresenterFactory', ...(oldRoots.size ? ['contexts', 'coreAlias', 'sharedAlias', 'presentationWorkspaces'] : [])].includes(propName(p.name) ?? ''));
    if (oldRoots.size) {
        kept.push(ts.factory.createPropertyAssignment('presentationWorkspaces', ts.factory.createArrayLiteralExpression([...workspaces].sort().map((w) => ts.factory.createStringLiteral(w)))));
        if (!kept.some((p) => propName(p.name) === 'runChecksBeforePush'))
            kept.push(ts.factory.createPropertyAssignment('runChecksBeforePush', ts.factory.createTrue()));
    }
    config =
        config.slice(0, exported.expression.getStart(configSource)) +
            printer.printNode(ts.EmitHint.Expression, ts.factory.createObjectLiteralExpression(kept, true), configSource) +
            config.slice(exported.expression.end);
    if (oldRoots.size || kept.length !== exported.expression.properties.length)
        writes.set(configFile, Buffer.from(config));
    const tsconfig = path.join(root, 'tsconfig.json');
    if (oldRoots.size && originals.has(tsconfig)) {
        const parsed = ts.parseConfigFileTextToJson(tsconfig, originals.get(tsconfig).toString());
        if (parsed.error)
            throw new Error('Cannot parse tsconfig.json safely.');
        const exclude = parsed.config.exclude ?? ['node_modules', 'bower_components', 'jspm_packages'];
        parsed.config.exclude = [...new Set([...exclude, 'src/app/.backup/**'])];
        writes.set(tsconfig, Buffer.from(JSON.stringify(parsed.config, null, '\t') + '\n'));
    }
    if (oldRoots.size) {
        const diSource = ts.createSourceFile(diFile, writes.get(diFile).toString(), ts.ScriptTarget.Latest, true);
        writes.set(diFile, Buffer.from(printer.printFile(diSource)));
    }
    if (!oldRoots.size && !upgradedSources.size && !issues.length)
        throw new Error('Nothing to migrate.');
    const moves = [...mapping].map(([from, to]) => ({ from, to }));
    for (const item of issues)
        item.file = mapping.get(item.file) ?? item.file;
    return {
        root,
        moves,
        issues,
        writes,
        originals,
        removes: [...mapping.keys()],
        workspaces: [...workspaces]
    };
}
export async function applyMigration(plan) {
    // Verify the plan before creating any backup or touching user files.
    for (const file of await files(path.join(plan.root, 'src')))
        if (!plan.originals.has(file))
            throw new Error(`New source file since planning: ${file}`);
    for (const [file, bytes] of plan.originals)
        if (!(await fs.readFile(file)).equals(bytes))
            throw new Error(`File changed since planning: ${file}`);
    for (const target of plan.writes.keys())
        if (!plan.originals.has(target)) {
            try {
                await fs.access(target);
                throw new Error(`Migration target already exists: ${target}`);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
    const snapshot = await fs.mkdtemp(path.join(await fs
        .mkdir(path.join(plan.root, '.azure-net/migrations'), { recursive: true })
        .then(() => path.join(plan.root, '.azure-net/migrations')), 'migration-'));
    const touched = new Set([...plan.removes, ...plan.writes.keys()]);
    for (const file of touched)
        if (plan.originals.has(file)) {
            const target = path.join(snapshot, 'original', path.relative(plan.root, file));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, plan.originals.get(file));
        }
    await fs.writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify({
        moves: plan.moves,
        generated: [...plan.writes.keys()].filter((p) => !plan.originals.has(p)),
        issues: plan.issues,
        hashes: [...touched]
            .filter((p) => plan.originals.has(p))
            .map((p) => ({ file: p, sha256: createHash('sha256').update(plan.originals.get(p)).digest('hex') }))
    }, null, 2));
    const report = path.join(snapshot, 'Report.md');
    await fs.writeFile(report, `# Migration report\n\n${plan.moves.length} files classified. Original bytes: ./original. Unknown files: src/app/.backup.\n\nRecognized presenter factories are converted to classes with scoped RegisterProvider accessors. Closure state is preserved. Async helpers are imported directly. Review unsupported factories and lifecycle requirements. Run azure-net check internal and your package manager's check/build.\n\n## Review\n${plan.issues.map((i) => `- [${slash(path.relative(plan.root, i.file))}](${i.file}): ${i.reason}`).join('\n')}\n\n## Moves\n${plan.moves.map((m) => `- ${slash(path.relative(plan.root, m.from))} -> [${slash(path.relative(plan.root, m.to))}](${m.to})`).join('\n')}\n`);
    try {
        for (const [file, bytes] of plan.writes) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, bytes);
        }
        for (const file of plan.removes)
            if (!plan.writes.has(file))
                await fs.unlink(file);
    }
    catch (error) {
        for (const file of touched) {
            const original = plan.originals.get(file);
            if (original) {
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, original);
            }
            else
                await fs.rm(file, { force: true });
        }
        throw new Error(`Migration rolled back after I/O failure. Snapshot: ${snapshot}`, { cause: error });
    }
    async function removeEmpty(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }))
            if (entry.isDirectory() && entry.name !== '.backup')
                await removeEmpty(path.join(dir, entry.name));
        if (!(await fs.readdir(dir)).length)
            await fs.rmdir(dir);
    }
    try {
        await removeEmpty(path.join(plan.root, 'src/app'));
    }
    catch (error) {
        console.warn(`Files migrated, but empty directory cleanup failed: ${String(error)}`);
    }
    return report;
}
export default async function migrate(options = {}) {
    const plan = await planMigration();
    console.log(`Migration plan: ${plan.moves.length} files, ${plan.workspaces.length} workspaces, ${plan.issues.length} review items.`);
    for (const move of plan.moves)
        console.log(`${path.relative(plan.root, move.from)} -> ${path.relative(plan.root, move.to)}`);
    if (options.dryRun) {
        for (const issue of plan.issues)
            console.warn(`${issue.file}: ${issue.reason}`);
        return;
    }
    if (!options.yes) {
        const answer = await prompts({
            type: 'confirm',
            name: 'apply',
            initial: false,
            message: 'Apply migration? Original files will be backed up; review/check/build is required afterwards.'
        });
        if (!answer.apply)
            return;
    }
    const report = await applyMigration(plan);
    console.log(`Migration complete. Review report: ${report}`);
    for (const issue of plan.issues)
        console.warn(`${issue.file}: ${issue.reason}`);
}
