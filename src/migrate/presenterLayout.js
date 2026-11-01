import path from 'node:path';
import ts from 'typescript';
import { parseSource } from '../checks/architecture.js';
const apply = (input, edits) => {
    for (const edit of edits.sort((a, b) => b.start - a.start))
        input = input.slice(0, edit.start) + edit.text + input.slice(edit.end);
    return input;
};
/** Separate simple scoped registration from the class; never move captured module state. */
export function migratePresenterLayout(sources, resolve, specifier) {
    const updates = new Map();
    const issues = [];
    const relocated = new Map();
    for (const [file, input] of sources) {
        if (!/[/\\]Presentation[/\\].*[/\\]Scopes[/\\].*Presenter\.[jt]s$/.test(file))
            continue;
        const source = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true);
        const imports = source.statements.filter(ts.isImportDeclaration);
        const registrations = new Set();
        for (const statement of imports) {
            if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@azure-net/kit/delivery')
                continue;
            const bindings = statement.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings))
                for (const entry of bindings.elements)
                    if ((entry.propertyName ?? entry.name).text === 'RegisterProvider')
                        registrations.add(entry.name.text);
        }
        const candidates = source.statements.filter((statement) => {
            if (!ts.isVariableStatement(statement) ||
                statement.declarationList.declarations.length !== 1 ||
                !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
                return false;
            const d = statement.declarationList.declarations[0];
            return (ts.isIdentifier(d.name) &&
                /^use.*Presenter$/.test(d.name.text) &&
                !!d.initializer &&
                ts.isCallExpression(d.initializer) &&
                ts.isIdentifier(d.initializer.expression) &&
                registrations.has(d.initializer.expression.text));
        });
        if (!candidates.length)
            continue;
        const index = path.join(path.dirname(file), file.endsWith('.js') ? 'index.js' : 'index.ts');
        const indexInput = updates.get(index) ?? sources.get(index) ?? '';
        const indexSource = ts.createSourceFile(index, indexInput, ts.ScriptTarget.Latest, true);
        const classes = source.statements.filter(ts.isClassDeclaration);
        const registration = candidates[0];
        const name = registration.declarationList.declarations[0].name.getText(source);
        let unsafe = candidates.length !== 1 ||
            classes.length !== 1 ||
            !classes[0]?.name ||
            !classes[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
            indexSource.statements.some((s) => !ts.isExportDeclaration(s) && !ts.isEmptyStatement(s));
        const options = { noLib: true, noResolve: true };
        const host = ts.createCompilerHost(options);
        host.getSourceFile = (value) => (value === file ? source : undefined);
        host.fileExists = (value) => value === file;
        host.readFile = (value) => (value === file ? input : undefined);
        const checker = ts.createProgram([file], options, host).getTypeChecker();
        const scan = (node) => {
            if (ts.isIdentifier(node)) {
                const symbol = ts.isShorthandPropertyAssignment(node.parent)
                    ? checker.getShorthandAssignmentValueSymbol(node.parent)
                    : checker.getSymbolAtLocation(node);
                for (const declaration of symbol?.declarations ?? []) {
                    if (declaration.getSourceFile() !== source ||
                        (declaration.getStart(source) >= registration.getStart(source) && declaration.end <= registration.end))
                        continue;
                    if (ts.isImportSpecifier(declaration) ||
                        ts.isImportClause(declaration) ||
                        ts.isNamespaceImport(declaration) ||
                        declaration === classes[0])
                        continue;
                    unsafe = true;
                }
            }
            ts.forEachChild(node, scan);
        };
        scan(registration.declarationList.declarations[0].initializer);
        for (const statement of source.statements) {
            if (statement === registration)
                continue;
            const check = (node) => {
                if (ts.isIdentifier(node) && node.text === name)
                    unsafe = true;
                ts.forEachChild(node, check);
            };
            check(statement);
        }
        if (unsafe) {
            issues.push({
                file,
                reason: 'Presenter registration captures module state, has same-file consumers or a custom index; separate its index factory manually.'
            });
            continue;
        }
        const indexEdits = [];
        for (const statement of indexSource.statements) {
            if (!ts.isExportDeclaration(statement) ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                resolve(index, statement.moduleSpecifier.text) !== file ||
                !statement.exportClause ||
                !ts.isNamedExports(statement.exportClause))
                continue;
            const local = statement.exportClause.elements.filter((e) => (e.propertyName ?? e.name).text === name);
            if (!local.length)
                continue;
            const kept = statement.exportClause.elements.filter((e) => !local.includes(e));
            indexEdits.push({
                start: statement.getStart(indexSource),
                end: statement.end,
                text: (kept.length
                    ? `export { ${kept.map((e) => e.getText(indexSource)).join(', ')} } from ${statement.moduleSpecifier.getText(indexSource)};\n`
                    : '') +
                    local
                        .filter((e) => e.name.text !== name)
                        .map((e) => `export { ${e.getText(indexSource)} };`)
                        .join('\n')
            });
        }
        const className = classes[0].name.text;
        const classSpecifier = './' + path.basename(file).replace(/\.[jt]s$/, '');
        updates.set(file, apply(input, [{ start: registration.getStart(source), end: registration.end, text: '' }]));
        updates.set(index, `${imports.map((s) => s.getText(source)).join('\n')}\nimport { ${className} } from ${JSON.stringify(classSpecifier)};\n${apply(indexInput, indexEdits)}\nexport * from ${JSON.stringify(classSpecifier)};\n${registration.getText(source)}\n`);
        relocated.set(file, index);
    }
    // The new index exports the original class as well as its registration accessor.
    for (const [file, original] of new Map([...sources, ...updates])) {
        if (!/\.(?:[jt]s|svelte)$/.test(file))
            continue;
        const source = parseSource(original, file);
        const edits = [];
        const visit = (node) => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                node.moduleSpecifier &&
                ts.isStringLiteral(node.moduleSpecifier)) {
                const target = resolve(file, node.moduleSpecifier.text);
                const index = target && relocated.get(target);
                if (index && file !== index && file !== target)
                    edits.push({
                        start: node.moduleSpecifier.getStart(source),
                        end: node.moduleSpecifier.end,
                        text: JSON.stringify(specifier(index, file))
                    });
            }
            if (ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
                node.arguments[0] &&
                ts.isStringLiteral(node.arguments[0])) {
                const argument = node.arguments[0];
                const target = resolve(file, argument.text);
                const index = target && relocated.get(target);
                if (index && file !== index && file !== target)
                    edits.push({ start: argument.getStart(source), end: argument.end, text: JSON.stringify(specifier(index, file)) });
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        if (edits.length)
            updates.set(file, apply(original, edits));
    }
    return { updates, issues, relocated };
}
