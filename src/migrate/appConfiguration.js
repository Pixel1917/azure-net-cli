import ts from 'typescript';
const methods = new Set([
    'useBoot',
    'useTranslations',
    'useClient',
    'useClientInit',
    'useClientError',
    'useServerInit',
    'useServer',
    'useServerError',
    'useServerFetch',
    'useReroute',
    'useTransport'
]);
/** Split only direct, known registrations; preserve hook arguments and their returns verbatim. */
export function migrateAppConfiguration(input, file) {
    if (!input.includes('createApp'))
        return { content: input, issues: [] };
    const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
    const options = { noLib: true, noResolve: true };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => (name === file ? source : undefined);
    host.fileExists = (name) => name === file;
    const checker = ts.createProgram([file], options, host).getTypeChecker();
    const creators = new Set();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== '@azure-net/kit')
            continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
            for (const binding of bindings.elements) {
                if ((binding.propertyName ?? binding.name).text === 'createApp') {
                    const symbol = checker.getSymbolAtLocation(binding.name);
                    if (symbol)
                        creators.add(symbol);
                }
            }
    }
    const edits = [];
    const issues = [];
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && creators.has(checker.getSymbolAtLocation(node.expression))) {
            const callback = node.arguments[0];
            if (!callback ||
                (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
                callback.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
                callback.parameters.length !== 1 ||
                !ts.isIdentifier(callback.parameters[0].name)) {
                issues.push('Unsupported or async createApp configurator: migrate manually to synchronous void configuration.');
                return;
            }
            const parameter = callback.parameters[0].name;
            const split = (expression) => {
                if (ts.isParenthesizedExpression(expression))
                    return split(expression.expression);
                if (ts.isIdentifier(expression) && checker.getSymbolAtLocation(expression) === checker.getSymbolAtLocation(parameter))
                    return [];
                if (!ts.isCallExpression(expression) ||
                    expression.questionDotToken ||
                    !ts.isPropertyAccessExpression(expression.expression) ||
                    expression.expression.questionDotToken ||
                    !methods.has(expression.expression.name.text))
                    return undefined;
                const prior = split(expression.expression.expression);
                return prior && [...prior, parameter.text + input.slice(expression.expression.expression.end, expression.end) + ';'];
            };
            const pending = [];
            let safe = true;
            if (ts.isBlock(callback.body)) {
                for (const [index, statement] of callback.body.statements.entries()) {
                    if (ts.isEmptyStatement(statement))
                        continue;
                    const expression = ts.isExpressionStatement(statement)
                        ? statement.expression
                        : ts.isReturnStatement(statement)
                            ? statement.expression
                            : undefined;
                    const lines = expression && split(expression);
                    if (!lines || (ts.isReturnStatement(statement) && index !== callback.body.statements.length - 1)) {
                        safe = false;
                        break;
                    }
                    if (ts.isReturnStatement(statement) || lines.length !== 1)
                        pending.push({ start: statement.getStart(source), end: statement.end, text: lines.join('\n') });
                }
            }
            else {
                const lines = split(callback.body);
                if (!lines)
                    safe = false;
                else
                    pending.push({ start: callback.body.getStart(source), end: callback.body.end, text: `{\n${lines.join('\n')}\n}` });
            }
            if (safe)
                edits.push(...pending);
            else {
                let legacy = !ts.isBlock(callback.body);
                const inspect = (child) => {
                    // Hook returns belong to the hook, not to the configurator.
                    if (ts.isFunctionLike(child))
                        return;
                    if (ts.isReturnStatement(child) && child.expression)
                        legacy = true;
                    if (ts.isCallExpression(child) &&
                        ts.isPropertyAccessExpression(child.expression) &&
                        methods.has(child.expression.name.text) &&
                        ts.isCallExpression(child.expression.expression))
                        legacy = true;
                    ts.forEachChild(child, inspect);
                };
                inspect(callback.body);
                if (legacy)
                    issues.push('Unsupported createApp configuration body: split registrations and remove configurator returns manually.');
            }
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    for (const edit of edits.sort((a, b) => b.start - a.start))
        input = input.slice(0, edit.start) + edit.text + input.slice(edit.end);
    return { content: input, issues };
}
