import ts from 'typescript';
import { parseSource } from '../checks/architecture.js';
const printer = ts.createPrinter();
const helperNames = new Set(['createAsyncAction', 'createAsyncResource']);
const apply = (input, edits) => {
    for (const edit of edits.sort((a, b) => b.start - a.start))
        input = input.slice(0, edit.start) + edit.text + input.slice(edit.end);
    return input;
};
export function migrateAsyncHelpers(input, file) {
    const source = parseSource(input, file);
    const edits = [];
    const factories = new Set();
    const occupied = new Set();
    const collect = (node) => {
        if (ts.isIdentifier(node))
            occupied.add(node.text);
        ts.forEachChild(node, collect);
    };
    collect(source);
    const unique = (base) => {
        let name = base;
        while (occupied.has(name))
            name += '_';
        occupied.add(name);
        return name;
    };
    const action = unique('kitCreateAsyncAction');
    const resource = unique('kitCreateAsyncResource');
    let helpersImported = false;
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== '@azure-net/kit/delivery')
            continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings))
            continue;
        const kept = bindings.elements.filter((entry) => {
            if ((entry.propertyName ?? entry.name).text !== 'createAsyncHelpers')
                return true;
            factories.add(entry.name.text);
            return false;
        });
        if (kept.length === bindings.elements.length)
            continue;
        const extra = helpersImported ? [] : [`createAsyncAction as ${action}`, `createAsyncResource as ${resource}`];
        helpersImported = true;
        edits.push({
            start: bindings.getStart(source),
            end: bindings.end,
            text: `{ ${[...kept.map((e) => e.getText(source)), ...extra].join(', ')} }`
        });
    }
    if (!factories.size)
        return input;
    const validate = (node) => {
        if (ts.isImportDeclaration(node))
            return;
        if (ts.isIdentifier(node) && factories.has(node.text)) {
            if (!ts.isCallExpression(node.parent) || node.parent.expression !== node || node.parent.arguments.length) {
                throw new Error(`${node.text} is not a direct zero-argument call`);
            }
        }
        ts.forEachChild(node, validate);
    };
    validate(source);
    const specialize = (name, errorType) => errorType
        ? `${name} as <Res = never, Req = never>(...args: Parameters<typeof ${name}<Res, Req, ${errorType}>>) => ReturnType<typeof ${name}<Res, Req, ${errorType}>>`
        : name;
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && factories.has(node.expression.text) && !node.arguments.length) {
            const errorType = node.typeArguments?.[0]?.getText(source);
            let keys = [...helperNames];
            const parent = node.parent;
            if (ts.isVariableDeclaration(parent) &&
                ts.isObjectBindingPattern(parent.name) &&
                !parent.name.elements.some((b) => b.dotDotDotToken)) {
                keys = parent.name.elements.map((b) => (b.propertyName ?? b.name).getText(source));
                if (keys.some((key) => !helperNames.has(key)))
                    throw new Error('Removed async helper members require manual migration');
            }
            edits.push({
                start: node.getStart(source),
                end: node.end,
                text: `({ ${keys.map((key) => `${key}: ${specialize(key === 'createAsyncAction' ? action : resource, errorType)}`).join(', ')} })`
            });
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return apply(input, edits);
}
/** Preserve lexical behavior while moving instance creation and dependencies to RegisterProvider. */
export function migratePresenterSource(input, file, factories, dependencies = new Map()) {
    const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
    const edits = [];
    const converted = new Map();
    const issues = [];
    const imports = new Set();
    const removedFactories = new Set();
    const existingImports = new Set();
    const dependencyImports = [];
    const occupied = new Set();
    const collectNames = (node) => {
        if (ts.isIdentifier(node))
            occupied.add(node.text);
        ts.forEachChild(node, collectNames);
    };
    collectNames(source);
    const unique = (base) => {
        let value = base;
        while (occupied.has(value))
            value += '_';
        occupied.add(value);
        return value;
    };
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== '@azure-net/kit/delivery' ||
            statement.importClause?.isTypeOnly)
            continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
            for (const entry of bindings.elements) {
                if (!entry.isTypeOnly)
                    existingImports.add(entry.propertyName ? `${entry.propertyName.text} as ${entry.name.text}` : entry.name.text);
            }
    }
    const existingRegistration = [...existingImports].find((name) => name === 'RegisterProvider' || name.startsWith('RegisterProvider as '));
    const registrationName = existingRegistration ? existingRegistration.split(' as ').at(-1) : unique('RegisterProvider');
    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
            continue;
        const declaration = statement.declarationList.declarations[0];
        const call = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) ||
            !call ||
            !ts.isCallExpression(call) ||
            !ts.isIdentifier(call.expression) ||
            !factories.has(call.expression.text))
            continue;
        const name = declaration.name.text;
        try {
            if (call.typeArguments?.length || declaration.type)
                throw new Error('Explicit factory result types require manual review');
            const callback = call.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
            if (!callback ||
                (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
                !ts.isBlock(callback.body) ||
                callback.typeParameters ||
                callback.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
                throw new Error('Expected a synchronous block factory');
            if (!((call.arguments.length === 2 && ts.isStringLiteral(call.arguments[0])) ||
                (call.arguments.length === 1 && call.arguments[0] === callback)))
                throw new Error('Custom factory arguments need manual review');
            const requestedImports = new Set();
            const dependency = dependencies.get(call.expression.text);
            const dependencyAlias = unique(name + 'Dependencies');
            const extraParameters = [];
            const extraArguments = [];
            const extraRegistrations = [];
            const helperSetup = [];
            const javascript = file.endsWith('.js');
            let needsDependencyImport = false;
            let runtimeDependencyImport = false;
            if (callback.parameters.length) {
                const param = callback.parameters[0];
                if (callback.parameters.length !== 1 || !ts.isObjectBindingPattern(param.name) || param.initializer)
                    throw new Error('Unsupported injected dependencies');
                for (const binding of param.name.elements) {
                    const original = (binding.propertyName ?? binding.name).getText(source);
                    if (!ts.isIdentifier(binding.name) || binding.initializer || binding.dotDotDotToken)
                        throw new Error('Nested, default or rest injected bindings need manual conversion');
                    if (dependency) {
                        if (!dependency.keys.has(original) && helperNames.has(original)) {
                            requestedImports.add(original === binding.name.text ? original : `${original} as ${binding.name.text}`);
                            continue;
                        }
                        if (!dependency.keys.has(original))
                            throw new Error(`Injected dependency ${original} is not statically known in its factory`);
                        if (helperNames.has(original) && dependency.helpers.has(original)) {
                            const helperAlias = unique('kit' + original[0].toUpperCase() + original.slice(1));
                            requestedImports.add(`${original} as ${helperAlias}`);
                            helperSetup.push(`const ${binding.name.text}${javascript ? '' : ': typeof ' + dependencyAlias + '[' + JSON.stringify(original) + ']'} = ${helperAlias};`);
                            if (!javascript)
                                needsDependencyImport = true;
                        }
                        else {
                            needsDependencyImport = runtimeDependencyImport = true;
                            extraParameters.push(`${binding.name.text}: typeof ${dependencyAlias}[${JSON.stringify(original)}]`);
                            extraArguments.push(binding.name.text);
                            extraRegistrations.push(`${dependencyAlias}[${JSON.stringify(original)}]`);
                        }
                    }
                    else {
                        if (!helperNames.has(original))
                            throw new Error(`Injected dependency ${original} requires manual conversion`);
                        requestedImports.add(original === binding.name.text ? original : `${original} as ${binding.name.text}`);
                    }
                }
            }
            const statements = [...callback.body.statements];
            let usesThis = false;
            const findThis = (node) => {
                if (node.kind === ts.SyntaxKind.ThisKeyword)
                    usesThis = true;
                ts.forEachChild(node, findThis);
            };
            findThis(callback.body);
            if (usesThis)
                throw new Error('Explicit this binding requires manual conversion');
            const result = statements.at(-1);
            if (!result || !ts.isReturnStatement(result) || !result.expression || !ts.isObjectLiteralExpression(result.expression))
                throw new Error('Expected a final object-literal return');
            const validateFlow = (node) => {
                if (ts.isFunctionLike(node) || ts.isClassLike(node))
                    return;
                if (ts.isReturnStatement(node) && node !== result)
                    throw new Error('Conditional early returns require manual conversion');
                if (ts.isIdentifier(node) && node.text === 'arguments')
                    throw new Error('Factory arguments binding requires manual conversion');
                ts.forEachChild(node, validateFlow);
            };
            validateFlow(callback.body);
            const keys = result.expression.properties.map((prop) => {
                if (!prop.name || !ts.isIdentifier(prop.name))
                    throw new Error('Spread/computed return keys require manual conversion');
                if (prop.name.text === 'constructor')
                    throw new Error('Reserved presenter member');
                return prop.name.text;
            });
            if (new Set(keys).size !== keys.length)
                throw new Error('Duplicate return keys');
            const parameters = [...extraParameters];
            const argumentsList = [...extraArguments];
            const registrationArguments = [...extraRegistrations];
            const registrations = [];
            const body = statements.filter((stmt) => {
                if (!ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1)
                    return true;
                const binding = stmt.declarationList.declarations[0];
                const value = binding.initializer;
                if (!ts.isObjectBindingPattern(binding.name) ||
                    !value ||
                    !ts.isCallExpression(value) ||
                    !ts.isIdentifier(value.expression) ||
                    !/Provider$/.test(value.expression.text))
                    return true;
                if (value.arguments.length)
                    throw new Error('Provider arguments require manual conversion');
                for (const entry of binding.name.elements) {
                    if (!ts.isIdentifier(entry.name) || entry.dotDotDotToken || entry.initializer)
                        throw new Error('Unsupported provider destructuring');
                    const key = (entry.propertyName ?? entry.name).getText(source).replace(/^['"]|['"]$/g, '');
                    parameters.push(`${entry.name.text}: ReturnType<typeof ${value.expression.text}>[${JSON.stringify(key)}]`);
                    argumentsList.push(entry.name.text);
                    registrationArguments.push(entry.name.text);
                }
                registrations.push(stmt.getText(source));
                return false;
            });
            // Keep lexical state and callbacks intact rather than guessing this-binding rewrites.
            const setup = `create${name}State`;
            if (new RegExp(`\\b(?:use${name}|${setup})\\b`).test(input))
                throw new Error('Generated declaration name already exists');
            const parameterList = (javascript ? argumentsList : parameters).join(', ');
            const members = result.expression.properties.map((property, index) => {
                const key = keys[index];
                return (`get ${key}() { return this.#state.${key}; }` +
                    (ts.isGetAccessorDeclaration(property) || callback.type
                        ? ''
                        : `\nset ${key}(value${javascript ? '' : `: ReturnType<typeof ${setup}>[${JSON.stringify(key)}]`}) { this.#state.${key} = value; }`));
            });
            const text = `function ${setup}(${parameterList})${callback.type ? ': ' + callback.type.getText(source) : ''} {\n${helperSetup.join('\n')}\n${body.map((stmt) => stmt.getText(source)).join('\n')}\n}\n\nexport class ${name} {\n#state${javascript ? '' : `: ReturnType<typeof ${setup}>`};\nconstructor(${parameterList}) { this.#state = ${setup}(${argumentsList.join(', ')}); }\n${members.join('\n')}\n}\n\nexport const use${name} = ${registrationName}(() => {\n${registrations.join('\n')}\nreturn new ${name}(${registrationArguments.join(', ')});\n}, 'scoped');`;
            if (needsDependencyImport && dependency)
                dependencyImports.push(`import ${runtimeDependencyImport ? '' : 'type '}{ ${dependency.exportName} as ${dependencyAlias} } from ${JSON.stringify(dependency.source)};`);
            edits.push({ start: statement.getStart(source), end: statement.end, text });
            converted.set(name, `use${name}`);
            removedFactories.add(call.expression.text);
            imports.add(registrationName === 'RegisterProvider' ? 'RegisterProvider' : `RegisterProvider as ${registrationName}`);
            for (const helper of requestedImports)
                imports.add(helper);
        }
        catch (error) {
            issues.push(`${name}: ${String(error)}. Original presenter retained.`);
        }
    }
    let output = apply(input, edits);
    if (converted.size) {
        const parsed = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true);
        const importEdits = [];
        for (const statement of parsed.statements) {
            if (!ts.isImportDeclaration(statement) ||
                !statement.importClause?.namedBindings ||
                !ts.isNamedImports(statement.importClause.namedBindings))
                continue;
            const bindings = statement.importClause.namedBindings;
            const kept = bindings.elements.filter((entry) => {
                if (!removedFactories.has(entry.name.text))
                    return true;
                let used = false;
                const visit = (node) => {
                    if (ts.isImportDeclaration(node))
                        return;
                    if (ts.isIdentifier(node) && node.text === entry.name.text)
                        used = true;
                    ts.forEachChild(node, visit);
                };
                visit(parsed);
                return used;
            });
            if (kept.length === bindings.elements.length)
                continue;
            const updated = kept.length || statement.importClause.name
                ? ts.factory.updateImportDeclaration(statement, statement.modifiers, ts.factory.updateImportClause(statement.importClause, statement.importClause.isTypeOnly, statement.importClause.name, kept.length ? ts.factory.updateNamedImports(bindings, kept) : undefined), statement.moduleSpecifier, statement.attributes)
                : undefined;
            importEdits.push({
                start: statement.getStart(parsed),
                end: statement.end,
                text: updated ? printer.printNode(ts.EmitHint.Unspecified, updated, parsed) : ''
            });
        }
        const neededImports = [...imports].filter((name) => !existingImports.has(name));
        output =
            dependencyImports.join('\n') +
                '\n' +
                (neededImports.length ? `import { ${neededImports.join(', ')} } from '@azure-net/kit/delivery';\n` : '') +
                apply(output, importEdits);
        const updated = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true);
        // Bind only this in-memory module: distinguish lexical shadows without loading dependencies.
        const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022 };
        const host = ts.createCompilerHost(options);
        host.getSourceFile = (name) => (name === file ? updated : undefined);
        host.fileExists = (name) => name === file;
        host.readFile = (name) => (name === file ? output : undefined);
        const checker = ts.createProgram([file], options, host).getTypeChecker();
        const symbols = new Map();
        for (const statement of updated.statements) {
            if (!ts.isClassDeclaration(statement) || !statement.name || !converted.has(statement.name.text))
                continue;
            const symbol = checker.getSymbolAtLocation(statement.name);
            if (symbol)
                symbols.set(symbol, converted.get(statement.name.text));
        }
        const references = [];
        const visit = (node) => {
            if (ts.isShorthandPropertyAssignment(node)) {
                const symbol = checker.getShorthandAssignmentValueSymbol(node);
                const name = symbol && symbols.get(symbol);
                if (name) {
                    references.push({ start: node.getStart(updated), end: node.end, text: `${node.name.text}: ${name}` });
                    return;
                }
            }
            if (ts.isIdentifier(node) && converted.has(node.text)) {
                const parent = node.parent;
                const declaration = ts.isClassDeclaration(parent) && parent.name === node;
                const construction = ts.isNewExpression(parent) && parent.expression === node;
                const symbol = checker.getSymbolAtLocation(node);
                const name = symbol && symbols.get(symbol);
                if (name && !declaration && !construction)
                    references.push({ start: node.getStart(updated), end: node.end, text: name });
            }
            ts.forEachChild(node, visit);
        };
        visit(updated);
        output = apply(output, references);
    }
    return { content: output, converted, issues };
}
