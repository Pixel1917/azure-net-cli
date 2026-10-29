import ts from 'typescript';
/** A direct HTTP-backed provider can become a context root without flattening its factories. */
export function migrateCompositionSource(input, context) {
    const source = ts.createSourceFile('Composition.ts', input, ts.ScriptTarget.Latest, true);
    const creators = new Set();
    const http = new Set();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
            continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings))
            continue;
        for (const binding of bindings.elements) {
            const imported = (binding.propertyName ?? binding.name).text;
            if (statement.moduleSpecifier.text === '@azure-net/kit' &&
                ['CreateServiceContainer', 'CreateDiContainer', 'createBoundaryProvider'].includes(imported))
                creators.add(binding.name.text);
            if (imported === 'HttpProvider')
                http.add(binding.name.text);
        }
    }
    const candidates = source.statements.filter((statement) => ts.isVariableStatement(statement) &&
        !!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        statement.declarationList.declarations.length === 1 &&
        !!statement.declarationList.declarations[0]?.initializer &&
        ts.isCallExpression(statement.declarationList.declarations[0].initializer) &&
        ts.isIdentifier(statement.declarationList.declarations[0].initializer.expression) &&
        creators.has(statement.declarationList.declarations[0].initializer.expression.text));
    if (candidates.length !== 1)
        return undefined;
    const statement = candidates[0];
    const declaration = statement.declarationList.declarations[0];
    const call = declaration.initializer;
    if (!ts.isIdentifier(declaration.name) ||
        declaration.type ||
        call.typeArguments?.length ||
        call.arguments.length !== 2 ||
        !ts.isStringLiteral(call.arguments[0]))
        return undefined;
    const settings = call.arguments[1];
    if (!ts.isObjectLiteralExpression(settings))
        return undefined;
    if (settings.properties.some((p) => !ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !['register', 'dependsOn'].includes(p.name.text)))
        return undefined;
    const depends = settings.properties.find((p) => p.name?.getText(source) === 'dependsOn');
    if (!depends ||
        !ts.isPropertyAssignment(depends) ||
        !ts.isObjectLiteralExpression(depends.initializer) ||
        depends.initializer.properties.length !== 1)
        return undefined;
    const dependency = depends.initializer.properties[0];
    if (!ts.isShorthandPropertyAssignment(dependency) || !http.has(dependency.name.text))
        return undefined;
    const register = settings.properties.find((p) => p.name?.getText(source) === 'register');
    if (!register || !ts.isPropertyAssignment(register) || !ts.isArrowFunction(register.initializer))
        return undefined;
    const rootName = `${context}Context`;
    if (new RegExp(`\\b${rootName}\\b`).test(input) || /\bMigratedCompositionRoot\b/.test(input))
        return undefined;
    // Keep the callable export for old consumers; it is the root's exact resolve function.
    const replacement = `export const ${rootName} = new MigratedCompositionRoot(${settings.getText(source)});\nexport const ${declaration.name.text} = ${rootName}.resolve;`;
    return (`import { CompositionRoot as MigratedCompositionRoot } from '@azure-net/kit';\n` +
        input.slice(0, statement.getStart(source)) +
        replacement +
        input.slice(statement.end));
}
