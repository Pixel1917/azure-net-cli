import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import ts from 'typescript';
import { selectWorkspace } from '../../utils/architecture.js';
const listDirectories = async (targetPath) => {
    try {
        const items = await fs.readdir(targetPath, { withFileTypes: true });
        return items.filter((item) => item.isDirectory()).map((item) => item.name);
    }
    catch {
        return [];
    }
};
const listSchemaFiles = async (targetPath) => {
    try {
        const files = await fs.readdir(targetPath);
        return files.filter((item) => item.endsWith('.ts') && item !== 'index.ts');
    }
    catch {
        return [];
    }
};
const resolveAliasMap = async () => {
    const map = new Map([
        ['#contexts', path.join(process.cwd(), 'src/app/Contexts')],
        ['#presentation', path.join(process.cwd(), 'src/app/Presentation')],
        ['#platform', path.join(process.cwd(), 'src/platform')]
    ]);
    return map;
};
const resolveImportToFile = async (fromFile, importPath, aliasMap) => {
    const rawImport = String(importPath ?? '').trim();
    if (!rawImport.length)
        return null;
    let absolute = '';
    if (rawImport.startsWith('.')) {
        absolute = path.resolve(path.dirname(fromFile), rawImport);
    }
    else {
        const alias = Array.from(aliasMap.keys()).find((key) => rawImport === key || rawImport.startsWith(`${key}/`));
        if (!alias)
            return null;
        const suffix = rawImport === alias ? '' : rawImport.slice(alias.length + 1);
        absolute = path.join(aliasMap.get(alias), suffix);
    }
    const tsCandidate = absolute.endsWith('.ts') ? absolute : `${absolute}.ts`;
    try {
        await fs.access(tsCandidate);
        return tsCandidate;
    }
    catch {
        const indexCandidate = path.join(absolute, 'index.ts');
        try {
            await fs.access(indexCandidate);
            return indexCandidate;
        }
        catch {
            return null;
        }
    }
};
const extractSchemaTypeName = (content) => {
    const typeMatch = content.match(/=\s*[A-Za-z0-9_]+<\s*([^>]+?)\s*>\s*\(\)/m);
    if (!typeMatch)
        return null;
    return String(typeMatch[1]).trim();
};
const findTypeImportPath = (content, typeName) => {
    const importRegex = /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        const importedList = match[1];
        const sourcePath = match[2];
        if (!importedList || !sourcePath)
            continue;
        const imported = importedList
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        if (imported.includes(typeName)) {
            return sourcePath;
        }
    }
    return null;
};
const extractInterfaceBody = (content, interfaceName) => {
    const source = ts.createSourceFile('Domain.ts', content, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === interfaceName);
    return declaration ? content.slice(declaration.members.pos, declaration.end - 1) : null;
};
const resolveRelativeExportPath = async (fromFile, exportPath) => {
    const absolute = path.resolve(path.dirname(fromFile), exportPath);
    const tsCandidate = absolute.endsWith('.ts') ? absolute : `${absolute}.ts`;
    try {
        await fs.access(tsCandidate);
        return tsCandidate;
    }
    catch {
        const indexCandidate = path.join(absolute, 'index.ts');
        try {
            await fs.access(indexCandidate);
            return indexCandidate;
        }
        catch {
            return null;
        }
    }
};
const findInterfaceBodyByExportGraph = async (entryFilePath, interfaceName, visited = new Set()) => {
    const resolvedPath = path.resolve(entryFilePath);
    if (visited.has(resolvedPath))
        return null;
    visited.add(resolvedPath);
    let content = '';
    try {
        content = await fs.readFile(resolvedPath, 'utf-8');
    }
    catch {
        return null;
    }
    const direct = extractInterfaceBody(content, interfaceName);
    if (direct !== null)
        return direct;
    const exportRegex = /export\s+(?:\*|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
        const exportPath = match[1];
        if (!exportPath || !exportPath.startsWith('.'))
            continue;
        const nextPath = await resolveRelativeExportPath(resolvedPath, exportPath);
        if (!nextPath)
            continue;
        const nested = await findInterfaceBodyByExportGraph(nextPath, interfaceName, visited);
        if (nested !== null)
            return nested;
    }
    return null;
};
const findInterfaceBodyByScan = async (rootDir, interfaceName) => {
    const queue = [rootDir];
    while (queue.length) {
        const current = queue.shift();
        if (!current)
            continue;
        let entries = [];
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(absolute);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.ts'))
                continue;
            const content = await fs.readFile(absolute, 'utf-8');
            const body = extractInterfaceBody(content, interfaceName);
            if (body !== null)
                return body;
        }
    }
    return null;
};
export const extractInterfaceFields = (body) => {
    const source = ts.createSourceFile('Type.ts', 'interface IType {' + body + '}', ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(ts.isInterfaceDeclaration);
    return (declaration?.members.flatMap((member) => {
        if (!ts.isPropertySignature(member) ||
            !member.type ||
            (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name) && !ts.isNumericLiteral(member.name)))
            return [];
        return [{ name: member.name.text, optional: Boolean(member.questionToken), type: member.type.getText(source) }];
    }) ?? []);
};
const buildRulesArray = (field) => {
    const ruleCalls = [];
    if (!field.optional) {
        ruleCalls.push('rules.required()');
    }
    if (field.type === 'string') {
        ruleCalls.push('rules.string()');
    }
    else if (field.type === 'number') {
        ruleCalls.push('rules.number()');
    }
    return `[${ruleCalls.join(', ')}]`;
};
export const updateRulesObject = (content, fields) => {
    const source = ts.createSourceFile('Schema.ts', content, ts.ScriptTarget.Latest, true);
    let object;
    const unwrap = (node) => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
    const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'rules') {
            const argument = node.arguments[0];
            if (argument && ts.isArrowFunction(argument) && !ts.isBlock(argument.body)) {
                const body = unwrap(argument.body);
                if (ts.isObjectLiteralExpression(body))
                    object ??= body;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!object)
        return null;
    const names = new Set(object.properties.flatMap((property) => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
        ? [property.name.text]
        : []));
    const additions = fields
        .filter((field) => !names.has(field.name))
        .map((field) => '\t\t' + JSON.stringify(field.name) + ': ' + buildRulesArray(field) + ',');
    if (!additions.length)
        return content;
    const last = object.properties.at(-1);
    let result = content.slice(0, object.end - 1) + '\n' + additions.join('\n') + '\n\t' + content.slice(object.end - 1);
    if (last && !object.properties.hasTrailingComma)
        result = result.slice(0, last.end) + ',' + result.slice(last.end);
    return result;
};
export default async function generateSchemaFromType() {
    const workspace = await selectWorkspace();
    if (!workspace)
        return;
    const presentationPath = path.join(workspace.path, 'Scopes');
    const presenterFolders = await listDirectories(presentationPath);
    if (!presenterFolders.length) {
        console.error(`❌ No presenter folders found in ${presentationPath}`);
        process.exitCode = 1;
        return;
    }
    const { presenterFolder } = await prompts({
        type: 'select',
        name: 'presenterFolder',
        message: 'Select presenter folder:',
        choices: presenterFolders.map((item) => ({ title: item, value: item })),
        initial: 0
    });
    if (!presenterFolder) {
        process.exitCode = 1;
        return;
    }
    const schemaFolderPath = path.join(presentationPath, String(presenterFolder), 'Schema');
    const schemas = await listSchemaFiles(schemaFolderPath);
    if (!schemas.length) {
        console.error(`❌ No schemas found in ${schemaFolderPath}`);
        process.exitCode = 1;
        return;
    }
    const { schemaFile } = await prompts({
        type: 'select',
        name: 'schemaFile',
        message: 'Select schema file:',
        choices: schemas.map((item) => ({ title: item, value: item })),
        initial: 0
    });
    if (!schemaFile) {
        process.exitCode = 1;
        return;
    }
    const schemaPath = path.join(schemaFolderPath, String(schemaFile));
    const schemaContent = await fs.readFile(schemaPath, 'utf-8');
    const typeName = extractSchemaTypeName(schemaContent);
    if (!typeName) {
        console.error('❌ Unable to resolve schema generic type.');
        process.exitCode = 1;
        return;
    }
    const importPath = findTypeImportPath(schemaContent, typeName);
    if (!importPath) {
        console.error(`❌ Unable to find import for type "${typeName}".`);
        process.exitCode = 1;
        return;
    }
    const aliasMap = await resolveAliasMap();
    const typeFilePath = await resolveImportToFile(schemaPath, importPath, aliasMap);
    if (!typeFilePath) {
        console.error(`❌ Unable to resolve type file path from import "${importPath}".`);
        process.exitCode = 1;
        return;
    }
    let interfaceBody = await findInterfaceBodyByExportGraph(typeFilePath, typeName);
    if (interfaceBody === null) {
        interfaceBody = await findInterfaceBodyByScan(path.dirname(typeFilePath), typeName);
    }
    if (interfaceBody === null) {
        console.error(`❌ Interface "${typeName}" not found in ${typeFilePath}`);
        process.exitCode = 1;
        return;
    }
    const interfaceFields = extractInterfaceFields(interfaceBody);
    if (!interfaceFields.length) {
        console.log('ℹ️ Interface has no explicit keys to transfer into rules.');
        return;
    }
    const updatedSchemaContent = updateRulesObject(schemaContent, interfaceFields);
    if (!updatedSchemaContent) {
        console.error('❌ Could not locate `.rules((rules) => ({}))` block in schema file.');
        process.exitCode = 1;
        return;
    }
    if (updatedSchemaContent === schemaContent) {
        console.log('ℹ️ Rules already include all keys from type.');
        return;
    }
    await fs.writeFile(schemaPath, updatedSchemaContent, 'utf-8');
    console.log(`✅ Schema updated from type: ${schemaPath}`);
}
