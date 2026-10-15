import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { formatConfig } from '../utils/viteConfig.js';
import { getPlatformPath } from '../utils/architecture.js';
/** Only initialize an empty generated DI; never replace application-specific registrations. */
export async function registerDatasource(className) {
    const file = path.join(getPlatformPath(), 'Foundation/DI/ApplicationProvider.ts');
    let content;
    try {
        content = await fs.readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        console.warn(`Register ${className} inside ApplicationProvider.register.`);
        return;
    }
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    let body;
    const visit = (n) => {
        if (ts.isPropertyAssignment(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === 'register' &&
            ts.isArrowFunction(n.initializer) &&
            !ts.isBlock(n.initializer.body)) {
            let value = n.initializer.body;
            while (ts.isParenthesizedExpression(value))
                value = value.expression;
            if (ts.isObjectLiteralExpression(value) && !value.properties.length)
                body = n.initializer.body;
        }
    };
    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement))
            continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) ||
                declaration.name.text !== 'ApplicationProvider' ||
                !declaration.initializer ||
                !ts.isCallExpression(declaration.initializer))
                continue;
            const options = declaration.initializer.arguments[1];
            if (options && ts.isObjectLiteralExpression(options))
                for (const property of options.properties)
                    visit(property);
        }
    }
    if (!body || content.includes(className)) {
        console.warn(`Existing DI preserved. Add const datasource = new ${className}({}) inside ApplicationProvider.register and pass it to repositories.`);
        return;
    }
    content =
        content.slice(0, body.getStart(source)) +
            `{\nconst datasource = new ${className}({});\n// Pass datasource to repositories and return UseCases factories below.\nreturn {};\n}` +
            content.slice(body.end);
    content = `import { ${className} } from '#platform/Foundation/Datasource';\n` + content;
    await fs.writeFile(file, await formatConfig(content, file));
}
