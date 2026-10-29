import { resolvePackageImport } from '../utils/packageImports.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readStaticAliases, VITE_CONFIGS, SVELTE_CONFIGS } from '../utils/viteConfig.js';
import ts from 'typescript';
export const appRoot = () => path.join(process.cwd(), 'src', 'app');
export const directories = async (root) => (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== '.backup')
    .map((entry) => entry.name);
export async function sourceFiles(root) {
    const files = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (['.backup', 'node_modules', '.git', '.svelte-kit', 'dist'].includes(entry.name))
            continue;
        const file = path.join(root, entry.name);
        if (entry.isDirectory())
            files.push(...(await sourceFiles(file)));
        else if (/\.(?:[cm]?[jt]sx?|svelte)$/.test(entry.name))
            files.push(file);
    }
    return files;
}
export function parseSource(content, filename = 'Source.ts') {
    // Mask markup while retaining offsets for accurate Svelte script diagnostics.
    if (filename.endsWith('.svelte')) {
        const pieces = [];
        let end = 0;
        const scripts = /<!--[^]*?-->|<script\b[^>]*>([^]*?)<\/script\s*>/gi;
        for (const match of content.matchAll(scripts)) {
            if (match[1] === undefined)
                continue;
            const start = match.index + match[0].indexOf('>') + 1;
            pieces.push(content.slice(end, start).replace(/[^\r\n]/g, ' '), match[1]);
            end = start + match[1].length;
        }
        pieces.push(content.slice(end).replace(/[^\r\n]/g, ' '));
        content = pieces.join('');
    }
    return ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
export function dependencies(content, filename = 'Source.ts') {
    const result = [];
    const sourceFile = parseSource(content, filename);
    const add = (literal, node, kind) => {
        if (!literal || (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal)))
            return;
        result.push({ source: literal.text, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, kind });
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            const bindings = clause?.namedBindings;
            const inlineTypes = !clause?.name &&
                bindings &&
                ts.isNamedImports(bindings) &&
                bindings.elements.length > 0 &&
                bindings.elements.every((element) => element.isTypeOnly);
            add(node.moduleSpecifier, node, !clause ? 'side-effect' : clause.isTypeOnly || inlineTypes ? 'type' : 'value');
        }
        else if (ts.isExportDeclaration(node))
            add(node.moduleSpecifier, node, 'export');
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
            add(node.arguments[0], node, 'dynamic');
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
            add(node.argument.literal, node, 'dynamic');
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
            add(node.moduleReference.expression, node, node.isTypeOnly ? 'type' : 'value');
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return result;
}
export function exportOnly(content) {
    return parseSource(content).statements.every((node) => ts.isExportDeclaration(node) || ts.isEmptyStatement(node));
}
export async function importResolver() {
    const aliases = {
        '#contexts': 'src/app/Contexts',
        '#presentation': 'src/app/Presentation',
        '#platform': 'src/platform',
        $lib: 'src/lib',
        '#lib': 'src/lib'
    };
    for (const name of [...VITE_CONFIGS, ...SVELTE_CONFIGS]) {
        const configPath = path.join(process.cwd(), name);
        try {
            await fs.access(configPath);
        }
        catch {
            continue;
        }
        Object.assign(aliases, readStaticAliases(await fs.readFile(configPath, 'utf8')));
        break;
    }
    let imports = {};
    try {
        imports = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')).imports ?? {};
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const entries = Object.entries(aliases).sort(([a], [b]) => b.length - a.length);
    return (file, source) => {
        const clean = source[0] + source.slice(1).split(/[?#]/)[0];
        const imported = resolvePackageImport(imports, clean, process.cwd());
        if (imported)
            return imported;
        if (clean.startsWith('.'))
            return path.resolve(path.dirname(file), clean);
        if (path.isAbsolute(clean))
            return path.resolve(clean);
        for (const [key, target] of entries) {
            const alias = key.replace(/\/\*$/, '');
            if (clean !== alias && !clean.startsWith(`${alias}/`))
                continue;
            return path.resolve(process.cwd(), target.replace(/\/\*$/, ''), clean.slice(alias.length).replace(/^\//, ''));
        }
        return null;
    };
}
export function location(file) {
    return path.relative(appRoot(), file).split(path.sep);
}
export function report(label, issues) {
    if (!issues.length) {
        console.log(`${label} check passed.`);
        return;
    }
    console.error(`${label} check failed:`);
    for (const issue of issues)
        console.error(`${path.relative(process.cwd(), issue.file)}:${issue.line} - ${issue.message}`);
    process.exitCode = 1;
}
export async function checkDependencies(label, rule) {
    const issues = [];
    try {
        const resolve = await importResolver();
        for (const file of await sourceFiles(appRoot())) {
            for (const entry of dependencies(await fs.readFile(file, 'utf8'), file)) {
                const target = resolve(file, entry.source);
                if (!target)
                    continue;
                const message = rule(location(file), location(target));
                if (message)
                    issues.push({ file, line: entry.line, message: `${message} (${entry.source})` });
            }
        }
    }
    catch (error) {
        issues.push({ file: appRoot(), line: 1, message: String(error) });
    }
    report(label, issues);
}
/** Static provider identities use module bindings, not dependency-object keys or optional display names. */
export async function providerDeclarations() {
    const files = await sourceFiles(path.join(process.cwd(), 'src'));
    const resolve = await importResolver();
    const modules = new Map(files.map((file) => [file, parseSource('', file)]));
    for (const file of files)
        modules.set(file, parseSource(await fs.readFile(file, 'utf8'), file));
    const moduleFile = (file, specifier) => {
        const target = resolve(file, specifier);
        if (!target)
            return undefined;
        const stem = target.replace(/\.[cm]?[jt]sx?$/, '');
        return [
            target,
            `${stem}.ts`,
            `${stem}.tsx`,
            `${stem}.js`,
            `${stem}.mts`,
            path.join(target, 'index.ts'),
            path.join(target, 'index.js')
        ].find((candidate) => modules.has(candidate));
    };
    const unwrap = (node) => {
        while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))
            node = node.expression;
        return node;
    };
    const bindings = new Map();
    const references = new Map();
    const exports = new Map();
    const stars = new Map();
    const key = (file, name) => `${file}#${name}`;
    for (const [file, source] of modules) {
        for (const statement of source.statements) {
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
                        continue;
                    bindings.set(key(file, declaration.name.text), unwrap(declaration.initializer));
                    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
                        exports.set(key(file, declaration.name.text), key(file, declaration.name.text));
                }
            }
            if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
                const target = moduleFile(file, statement.moduleSpecifier.text);
                if (!target)
                    continue;
                const clause = statement.importClause;
                if (clause?.name)
                    references.set(key(file, clause.name.text), key(target, 'default'));
                if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
                    for (const element of clause.namedBindings.elements)
                        references.set(key(file, element.name.text), key(target, (element.propertyName ?? element.name).text));
                if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
                    references.set(key(file, clause.namedBindings.name.text), `${target}#`);
            }
            if (ts.isExportDeclaration(statement)) {
                const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
                    ? moduleFile(file, statement.moduleSpecifier.text)
                    : file;
                if (!target)
                    continue;
                if (statement.exportClause && ts.isNamedExports(statement.exportClause))
                    for (const element of statement.exportClause.elements)
                        exports.set(key(file, element.name.text), key(target, (element.propertyName ?? element.name).text));
                else if (!statement.exportClause)
                    stars.set(file, [...(stars.get(file) ?? []), target]);
            }
            if (ts.isExportAssignment(statement))
                bindings.set(key(file, 'default'), unwrap(statement.expression));
        }
    }
    const expressionKey = (file, expression) => {
        expression = unwrap(expression);
        if (ts.isIdentifier(expression))
            return key(file, expression.text);
        if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'resolve')
            return expressionKey(file, expression.expression);
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
            const namespace = references.get(key(file, expression.expression.text));
            if (namespace?.endsWith('#'))
                return namespace + expression.name.text;
        }
        return undefined;
    };
    const lookup = (id, seen = new Set()) => {
        if (seen.has(id))
            return undefined;
        seen.add(id);
        const ref = references.get(id) ?? exports.get(id);
        if (ref && ref !== id)
            return lookup(ref, seen);
        if (bindings.has(id)) {
            const alias = expressionKey(id.slice(0, id.lastIndexOf('#')), bindings.get(id));
            return alias ? lookup(alias, seen) : id;
        }
        const split = id.lastIndexOf('#');
        for (const target of stars.get(id.slice(0, split)) ?? []) {
            const found = lookup(key(target, id.slice(split + 1)), new Set(seen));
            if (found)
                return found;
        }
        return undefined;
    };
    const objectProperties = (file, expression, seen = new Set()) => {
        if (!expression)
            return [];
        expression = unwrap(expression);
        const id = expressionKey(file, expression);
        if (id) {
            const target = lookup(id);
            if (!target || seen.has(target))
                return [];
            seen.add(target);
            return objectProperties(target.slice(0, target.lastIndexOf('#')), bindings.get(target), seen);
        }
        if (!ts.isObjectLiteralExpression(expression))
            return [];
        return expression.properties.flatMap((property) => ts.isSpreadAssignment(property) ? objectProperties(file, property.expression, new Set(seen)) : [property]);
    };
    const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
    const providers = [];
    for (const [file, source] of modules) {
        const apis = new Map(['CreateServiceContainer', 'CompositionRoot', 'CreateDiContainer'].map((name) => [name, name]));
        const namespaces = new Set();
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                !statement.moduleSpecifier.text.startsWith('@azure-net/kit'))
                continue;
            const clause = statement.importClause;
            if (clause?.isTypeOnly)
                continue;
            if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
                for (const item of clause.namedBindings.elements)
                    if (!item.isTypeOnly)
                        apis.set(item.name.text, (item.propertyName ?? item.name).text);
            if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
                namespaces.add(clause.namedBindings.name.text);
        }
        const visit = (node) => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const callee = node.expression;
                const api = ts.isIdentifier(callee)
                    ? apis.get(callee.text)
                    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)
                        ? callee.name.text
                        : undefined;
                if (api && ['CreateServiceContainer', 'CompositionRoot', 'CreateDiContainer'].includes(api)) {
                    const args = node.arguments ?? [];
                    const config = args[api === 'CompositionRoot' ? 0 : 1];
                    const properties = objectProperties(file, config);
                    const get = (name) => {
                        const property = [...properties]
                            .reverse()
                            .find((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
                        return property && ts.isPropertyAssignment(property)
                            ? property.initializer
                            : property && ts.isShorthandPropertyAssignment(property)
                                ? property.name
                                : undefined;
                    };
                    const explicitName = api === 'CompositionRoot' ? literal(get('name')) : literal(args[0]);
                    const bound = [...bindings].find(([id, expression]) => id.startsWith(`${file}#`) && expression === node)?.[0];
                    const id = bound ?? key(file, `@${node.pos}`);
                    const dependsOn = objectProperties(file, get('dependsOn')).flatMap((property) => {
                        const expression = ts.isShorthandPropertyAssignment(property)
                            ? property.name
                            : ts.isPropertyAssignment(property)
                                ? property.initializer
                                : undefined;
                        const ref = expression && expressionKey(expression.getSourceFile().fileName, expression);
                        if (ref)
                            return [lookup(ref) ?? ref];
                        if (api === 'CreateDiContainer' && property.name && ts.isIdentifier(property.name))
                            return [`legacy:${property.name.text}`];
                        return [];
                    });
                    providers.push({
                        key: id,
                        name: bound?.slice(bound.lastIndexOf('#') + 1) ?? explicitName ?? 'CompositionRoot',
                        explicitName,
                        file,
                        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                        dependsOn
                    });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    for (const provider of providers)
        provider.dependsOn = provider.dependsOn.map((dependency) => dependency.startsWith('legacy:')
            ? (providers.find((item) => item.explicitName === dependency.slice(7))?.key ?? dependency)
            : dependency);
    return providers;
}
