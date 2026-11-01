import ts from 'typescript';
/** Upgrade only imported kit symbols; local functions with the same name are untouched. */
export function migrateCurrentApis(input, file) {
    const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
    const edits = [];
    const issues = [];
    const options = { noLib: true, noResolve: true };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => (name === file ? source : undefined);
    host.fileExists = (name) => name === file;
    host.readFile = (name) => (name === file ? input : undefined);
    const checker = ts.createProgram([file], options, host).getTypeChecker();
    const registrations = new Set();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
            continue;
        const module = statement.moduleSpecifier.text;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings))
            continue;
        for (const binding of bindings.elements) {
            const imported = binding.propertyName ?? binding.name;
            if (module === '@azure-net/kit' && ['CreateDiContainer', 'createBoundaryProvider'].includes(imported.text)) {
                edits.push({ start: binding.getStart(source), end: binding.end, text: `CreateServiceContainer as ${binding.name.text}` });
                issues.push('Service container API upgraded without flattening dependencies. Review per-context CompositionRoot, HttpProvider dependsOn and resolve wiring manually.');
            }
            if (module === '@azure-net/kit/delivery' && imported.text === 'RegisterProvider') {
                const symbol = checker.getSymbolAtLocation(binding.name);
                if (symbol)
                    registrations.add(symbol);
            }
        }
    }
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const symbol = checker.getSymbolAtLocation(node.expression);
            if (symbol && registrations.has(symbol)) {
                const lifecycle = node.arguments[1];
                if (lifecycle && ts.isStringLiteral(lifecycle) && ['scoped', 'singleton', 'transient'].includes(lifecycle.text))
                    edits.push({ start: lifecycle.getStart(source), end: lifecycle.end, text: `{ lifecycle: ${JSON.stringify(lifecycle.text)} }` });
                else if (lifecycle && !ts.isObjectLiteralExpression(lifecycle))
                    issues.push('RegisterProvider has dynamic lifecycle options; manual intervention required.');
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    let content = input;
    for (const edit of edits.sort((a, b) => b.start - a.start))
        content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    return { content, issues };
}
