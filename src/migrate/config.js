import ts from 'typescript';
import { flattenConfigLiterals } from '../utils/flattenConfig.js';
export function migrateConfig(input, boundaries) {
    const content = flattenConfigLiterals(input);
    const source = ts.createSourceFile('azure-net.config.ts', content, ts.ScriptTarget.Latest, true);
    const exported = source.statements.find(ts.isExportAssignment);
    const issues = [];
    if (!exported || !ts.isObjectLiteralExpression(exported.expression))
        return { content: input, issues: ['Non-literal config retained; configure appBoundaries manually.'] };
    const name = (p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
    const properties = exported.expression.properties;
    const names = properties.map(name);
    if (properties.some((p) => ts.isSpreadAssignment(p) || !ts.isPropertyAssignment(p)) || new Set(names).size !== names.length)
        return { content: input, issues: ['Dynamic, accessor or duplicate config properties retained; review appBoundaries manually.'] };
    const canonical = names.includes('appBoundaries');
    let changed = false;
    const kept = properties.flatMap((p) => {
        if (name(p) === 'defaultPresenterFactory') {
            changed = true;
            return [];
        }
        if (!canonical && name(p) === 'presentationWorkspaces' && ts.isPropertyAssignment(p)) {
            changed = true;
            return [ts.factory.updatePropertyAssignment(p, ts.factory.createIdentifier('appBoundaries'), p.initializer)];
        }
        return [p];
    });
    if (boundaries.length && !names.includes('appBoundaries') && !names.includes('presentationWorkspaces')) {
        changed = true;
        kept.push(ts.factory.createPropertyAssignment('appBoundaries', ts.factory.createArrayLiteralExpression(boundaries.map((v) => ts.factory.createStringLiteral(v)))));
    }
    if (!changed)
        return { content: input, issues };
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return {
        content: content.slice(0, exported.expression.getStart(source)) +
            printer.printNode(ts.EmitHint.Expression, ts.factory.createObjectLiteralExpression(kept, true), source) +
            content.slice(exported.expression.end),
        issues
    };
}
