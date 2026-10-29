import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { exportOnly, location, parseSource, report, sourceFiles } from './architecture.js';
const interfaceName = (name) => /^I[A-Z]/.test(name);
const dependencyName = (name) => /(?:Repository|Datasource|DataSource|UseCases)$/i.test(name);
const entityName = (name) => (ts.isIdentifier(name) ? name.text : name.right.text);
export default async function checkDomain() {
    const issues = [];
    const root = path.join(process.cwd(), 'src');
    try {
        for (const file of await sourceFiles(root)) {
            const parts = location(file);
            const context = parts[0] === 'Contexts';
            const domain = context && parts[parts[1] === 'SharedKernel' ? 2 : 3] === 'Domain';
            const content = await fs.readFile(file, 'utf8');
            const source = parseSource(content, file);
            const issue = (node, message) => {
                issues.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, message });
            };
            const basename = path.basename(file).replace(/(?:\.d)?\.[^.]+$/, '');
            const suffix = parts.includes('Resources')
                ? 'Resource'
                : parts.includes('Repositories')
                    ? 'Repository'
                    : parts.includes('UseCases')
                        ? 'UseCases'
                        : parts.includes('Services')
                            ? 'Service'
                            : null;
            if (context && suffix && basename !== 'index' && !basename.endsWith(suffix))
                issue(source, `File name must end with ${suffix}`);
            if (domain && basename === 'index' && !exportOnly(content))
                issue(source, 'index.ts must contain only exports. Move declarations to separate files');
            if (domain && basename !== 'index' && interfaceName(basename))
                issue(source, 'Domain file names must not start with "I". Keep "I" only in interface/type names');
            // Preserve imported names so aliases cannot disguise concrete dependencies.
            const imported = new Map();
            const classes = new Set();
            for (const statement of source.statements) {
                if (ts.isClassDeclaration(statement) && statement.name)
                    classes.add(statement.name.text);
                if (ts.isImportDeclaration(statement)) {
                    if (statement.importClause?.name && ts.isStringLiteral(statement.moduleSpecifier)) {
                        const name = path.basename(statement.moduleSpecifier.text).replace(/\.[cm]?[jt]sx?$/, '');
                        if (dependencyName(name))
                            imported.set(statement.importClause.name.text, name);
                    }
                    const bindings = statement.importClause?.namedBindings;
                    if (bindings && ts.isNamedImports(bindings))
                        for (const item of bindings.elements)
                            imported.set(item.name.text, (item.propertyName ?? item.name).text);
                }
            }
            const original = (name) => imported.get(name) ?? name;
            const isInterface = (name) => interfaceName(original(name)) && !classes.has(name);
            const typeNames = (node) => {
                if (!node)
                    return [];
                const names = [];
                const visit = (child) => {
                    if (ts.isTypeReferenceNode(child))
                        names.push(entityName(child.typeName));
                    ts.forEachChild(child, visit);
                };
                visit(node);
                return names;
            };
            const visit = (node) => {
                if (ts.isEnumDeclaration(node)) {
                    if (!node.name.text.endsWith('Enum'))
                        issue(node, `Enum "${node.name.text}" must end with Enum`);
                    if (basename !== 'index' && !basename.endsWith('Enum'))
                        issue(node, 'Enum file name must end with Enum');
                }
                if (context && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) {
                    if (ts.isInterfaceDeclaration(node) && !interfaceName(node.name.text))
                        issue(node, `Interface "${node.name.text}" must start with "I" and have uppercase second letter`);
                    if (domain && ts.isTypeAliasDeclaration(node) && !/^[IT][A-Z]/.test(node.name.text))
                        issue(node, `Type "${node.name.text}" must start with "I" or "T"`);
                }
                if (context &&
                    suffix &&
                    (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
                    (!node.name || !node.name.text.endsWith(suffix)))
                    issue(node, `Class/interface name must end with ${suffix}`);
                if (context && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
                    let allowed = false;
                    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
                        if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isFunctionLike(parent))
                            allowed = true;
                        if ((ts.isNewExpression(parent) || ts.isCallExpression(parent)) &&
                            ts.isIdentifier(parent.expression) &&
                            original(parent.expression.text) === 'CompositionRoot')
                            allowed = true;
                    }
                    if (!allowed)
                        issue(node, 'Contexts cannot declare top-level functions; use class methods or CompositionRoot callbacks');
                }
                if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
                    const name = node.name?.text ?? basename;
                    if (/(Repository|UseCases|Presenter)$/.test(name) ||
                        parts.some((part) => ['Repositories', 'UseCases', 'Presenters'].includes(part))) {
                        for (const member of node.members) {
                            if (!ts.isConstructorDeclaration(member))
                                continue;
                            for (const parameter of member.parameters) {
                                const names = typeNames(parameter.type);
                                const parameterName = ts.isIdentifier(parameter.name) ? parameter.name.text : '';
                                const initializer = parameter.initializer;
                                let initializerName = '';
                                if (initializer && (ts.isNewExpression(initializer) || ts.isCallExpression(initializer))) {
                                    const expression = initializer.expression;
                                    if (ts.isIdentifier(expression))
                                        initializerName = original(expression.text);
                                }
                                const dependency = /(?:repo|repository|datasource|usecases?)$/i.test(parameterName) ||
                                    names.some((name) => dependencyName(original(name))) ||
                                    dependencyName(initializerName);
                                if (!dependency)
                                    continue;
                                if (!parameter.type ||
                                    !names.length ||
                                    names.some((name) => dependencyName(original(name)) && !isInterface(name)) ||
                                    !names.some(isInterface))
                                    issue(parameter, `Constructor dependency "${parameterName}" must use an interface for repository/datasource/usecase dependencies`);
                            }
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
    }
    catch (error) {
        issues.push({ file: root, line: 1, message: String(error) });
    }
    report('Domain', issues);
}
