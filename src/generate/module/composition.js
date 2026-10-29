import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import prompts from 'prompts';
import { getContextPath, getPlatformPath, normalizePascalName } from '../../utils/architecture.js';
import { getRepositoryMeta, printApplicationProviderWiring } from './repositoryModuleShared.js';
const unwrap = (node) => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
const propertyName = (node) => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;
export function mergeComposition(content, input) {
    const context = normalizePascalName(input.context);
    const aggregate = normalizePascalName(input.aggregate);
    const datasource = normalizePascalName(input.datasource);
    const meta = getRepositoryMeta(input.repository);
    const imports = [
        ['CompositionRoot', '@azure-net/kit'],
        ['HttpProvider', '#platform/Foundation/Provider'],
        [meta.className, `#contexts/${context}/${aggregate}/Infrastructure/Repositories/${meta.className}`],
        [meta.useCasesClassName, `#contexts/${context}/${aggregate}/Application/UseCases/${meta.useCasesClassName}`]
    ];
    const registration = `${meta.useCasesClassName}: () => new ${meta.useCasesClassName}(new ${meta.className}(HttpProvider.${datasource}))`;
    if (!content.trim())
        return (imports.map(([name, from]) => `import { ${name} } from '${from}';`).join('\n') +
            `\n\nexport const ${context}Context = new CompositionRoot({\n dependsOn: { HttpProvider },\n register: ({ HttpProvider }) => ({\n  ${registration}\n })\n});\n`);
    const source = ts.createSourceFile('Composition.ts', content, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length)
        throw new Error('Composition.ts contains syntax errors; automatic edit refused.');
    const edits = [];
    const missing = [];
    for (const [name, from] of imports) {
        let found = false;
        for (const statement of source.statements) {
            if (ts.isImportDeclaration(statement)) {
                const bindings = statement.importClause?.namedBindings;
                if (statement.importClause?.name?.text === name || (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name))
                    throw new Error('Import binding collision for ' + name);
                if (bindings && ts.isNamedImports(bindings))
                    for (const entry of bindings.elements) {
                        if (entry.name.text !== name)
                            continue;
                        if (statement.moduleSpecifier.getText(source).slice(1, -1) !== from ||
                            (entry.propertyName?.text ?? entry.name.text) !== name ||
                            statement.importClause?.isTypeOnly ||
                            entry.isTypeOnly)
                            throw new Error(`Import collision for ${name}; update Composition.ts manually.`);
                        found = true;
                    }
            }
            else if ((ts.isClassDeclaration(statement) ||
                ts.isFunctionDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement)) &&
                statement.name?.text === name) {
                throw new Error(`Declaration collision for ${name}.`);
            }
            else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => d.name.getText(source) === name)) {
                throw new Error(`Declaration collision for ${name}.`);
            }
        }
        if (!found)
            missing.push(`import { ${name} } from '${from}';`);
    }
    const declaration = source.statements
        .filter(ts.isVariableStatement)
        .flatMap((s) => [...s.declarationList.declarations])
        .find((d) => d.name.getText(source) === `${context}Context`);
    if (!declaration?.initializer ||
        !ts.isNewExpression(declaration.initializer) ||
        declaration.initializer.expression.getText(source) !== 'CompositionRoot')
        throw new Error('Expected an exported Context = new CompositionRoot({...}); update Composition.ts manually.');
    const config = declaration.initializer.arguments?.[0];
    if (!config || !ts.isObjectLiteralExpression(config) || config.properties.some((p) => ts.isSpreadAssignment(p) || !propertyName(p)))
        throw new Error('Composition configuration is not a static object; manual wiring required.');
    const getProperty = (object, name) => {
        const matches = object.properties.filter((p) => propertyName(p) === name);
        if (matches.length > 1)
            throw new Error(`Duplicate ${name} in Composition.ts.`);
        return matches[0];
    };
    const append = (object, text) => {
        const last = object.properties.at(-1);
        const position = last?.end ?? object.getStart(source) + 1;
        edits.push({ start: position, end: position, text: (last ? ',' : '') + '\n ' + text });
        // Existing trailing comma belongs to the newly appended property.
    };
    const register = getProperty(config, 'register');
    if (!register || !ts.isPropertyAssignment(register))
        throw new Error('Manual register method; automatic edit refused.');
    const fn = unwrap(register.initializer);
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
        throw new Error('register must be an inline function.');
    let result;
    if (ts.isBlock(fn.body)) {
        const returns = fn.body.statements.filter(ts.isReturnStatement);
        if (returns.length !== 1 ||
            fn.body.statements.some((s) => !ts.isReturnStatement(s) && !ts.isVariableStatement(s) && !ts.isExpressionStatement(s)))
            throw new Error('Branching register body requires manual wiring.');
        result = returns[0]?.expression;
    }
    else
        result = fn.body;
    result = result && unwrap(result);
    if (!result || !ts.isObjectLiteralExpression(result) || result.properties.some((p) => ts.isSpreadAssignment(p) || !propertyName(p)))
        throw new Error('register must return a static service object.');
    const existing = getProperty(result, meta.useCasesClassName);
    if (existing) {
        if (existing.getText(source).replace(/\s/g, '') !== registration.replace(/\s/g, ''))
            throw new Error(`Service ${meta.useCasesClassName} already exists; it was not overwritten.`);
        return content;
    }
    const depends = getProperty(config, 'dependsOn');
    if (depends) {
        if (!ts.isPropertyAssignment(depends) ||
            !ts.isObjectLiteralExpression(depends.initializer) ||
            depends.initializer.properties.some((p) => ts.isSpreadAssignment(p) || !propertyName(p)))
            throw new Error('Dynamic dependsOn requires manual wiring.');
        const http = getProperty(depends.initializer, 'HttpProvider');
        if (!http)
            append(depends.initializer, 'HttpProvider');
        else if (!ts.isShorthandPropertyAssignment(http) &&
            !(ts.isPropertyAssignment(http) && http.initializer.getText(source) === 'HttpProvider'))
            throw new Error('HttpProvider dependency has custom wiring; automatic edit refused.');
    }
    else
        append(config, 'dependsOn: { HttpProvider }');
    const reserved = new Set([meta.className, meta.useCasesClassName]);
    const bindingNames = (name) => ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((e) => (ts.isBindingElement(e) ? bindingNames(e.name) : []));
    for (const p of fn.parameters)
        if (bindingNames(p.name).some((n) => reserved.has(n)))
            throw new Error('register dependency shadows a generated constructor.');
    if (ts.isBlock(fn.body))
        for (const statement of fn.body.statements) {
            if (ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.some((d) => bindingNames(d.name).some((n) => reserved.has(n) || n === 'HttpProvider')))
                throw new Error('register local binding shadows an injected dependency; manual wiring required.');
        }
    const parameter = fn.parameters[0];
    if (!parameter) {
        edits.push({ start: fn.parameters.pos, end: fn.parameters.pos, text: '{ HttpProvider }' });
    }
    else {
        if (!ts.isObjectBindingPattern(parameter.name) || parameter.initializer || parameter.name.elements.some((e) => e.dotDotDotToken))
            throw new Error('register dependencies require manual wiring.');
        const binding = parameter.name.elements.find((e) => (e.propertyName ?? e.name).getText(source) === 'HttpProvider');
        if (binding && (binding.name.getText(source) !== 'HttpProvider' || binding.initializer))
            throw new Error('Renamed HttpProvider requires manual wiring.');
        if (!binding) {
            const last = parameter.name.elements.at(-1);
            const position = last?.end ?? parameter.name.getStart(source) + 1;
            edits.push({ start: position, end: position, text: (last ? ',' : '') + ' HttpProvider' });
        }
    }
    append(result, registration);
    if (missing.length)
        edits.push({ start: 0, end: 0, text: missing.join('\n') + '\n' });
    return edits.sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), content);
}
export function httpProviderHasDatasource(content, datasource) {
    const source = ts.createSourceFile('HttpProvider.ts', content, ts.ScriptTarget.Latest, true);
    const declaration = source.statements
        .filter(ts.isVariableStatement)
        .flatMap((s) => [...s.declarationList.declarations])
        .find((d) => d.name.getText(source) === 'HttpProvider');
    if (!declaration?.initializer || !ts.isCallExpression(declaration.initializer))
        return false;
    const config = declaration.initializer.arguments.find(ts.isObjectLiteralExpression);
    if (!config)
        return false;
    const register = config.properties.find((p) => propertyName(p) === 'register');
    if (!register || !ts.isPropertyAssignment(register))
        return false;
    const fn = unwrap(register.initializer);
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
        return false;
    let value;
    if (ts.isBlock(fn.body)) {
        const returns = fn.body.statements.filter(ts.isReturnStatement);
        if (returns.length !== 1)
            return false;
        value = returns[0]?.expression;
    }
    else
        value = fn.body;
    value = value && unwrap(value);
    return !!value && ts.isObjectLiteralExpression(value) && value.properties.some((p) => propertyName(p) === datasource);
}
export async function wireComposition(input) {
    const provider = path.join(getPlatformPath(), 'Foundation/Provider/HttpProvider.ts');
    let providerText;
    try {
        providerText = await fs.readFile(provider, 'utf8');
    }
    catch {
        throw new Error('Create Foundation/Provider/HttpProvider.ts before automatic composition wiring.');
    }
    if (!httpProviderHasDatasource(providerText, input.datasource))
        throw new Error('HttpProvider does not statically register ' + input.datasource + '. Register the datasource manually before composition wiring.');
    const file = path.join(getContextPath(input.context), 'Composition.ts');
    let content = '';
    try {
        content = await fs.readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const next = mergeComposition(content, input);
    if (next !== content) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, next);
    }
}
export async function prepareComposition(input) {
    const { automatic } = await prompts({ type: 'confirm', name: 'automatic', message: 'Wire Composition.ts automatically?', initial: true });
    if (automatic === undefined)
        return false;
    if (automatic) {
        try {
            await wireComposition(input);
            return true;
        }
        catch (error) {
            console.warn(error.message);
        }
    }
    printApplicationProviderWiring(input.context, input.repository, input.datasource, input.aggregate);
    const { ready } = await prompts({
        type: 'confirm',
        name: 'ready',
        message: 'Composition wired manually? Continue to presenter?',
        initial: false
    });
    return ready === true;
}
