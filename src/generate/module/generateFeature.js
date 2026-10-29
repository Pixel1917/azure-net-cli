import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { getAggregatePath, getPresentationPath, normalizePascalName, ensureAggregateStructure } from '../../utils/architecture.js';
import { writeIfNotExists } from '../../utils/fileUtils.js';
import { buildRepositoryContent, createUseCasesForRepository, ensureDomainScaffold, getDomainTypes, getRepositoryMeta, resolveRepositoriesPath, selectContext, selectAggregate, selectDatasource, resolveDatasource, writeRepositoryInterface } from './repositoryModuleShared.js';
import { prepareComposition, wireComposition } from './composition.js';
import generatePresenter from './generatePresenter.js';
const identifier = (name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name) && !['constructor', 'prototype', '__proto__', 'then'].includes(name);
function validType(type) {
    if (typeof type !== 'string' || !type.trim())
        throw new Error('A non-empty type expression is required.');
    const source = ts.createSourceFile('Type.ts', 'type Check = ' + type + ';', ts.ScriptTarget.Latest, true);
    const diagnostics = source.parseDiagnostics;
    if (diagnostics.length || source.statements.length !== 1 || !ts.isTypeAliasDeclaration(source.statements[0]))
        throw new Error('Invalid type expression: ' + type);
}
export function presetMethods(name, route, idType = 'string') {
    return [
        { name: 'collection', httpMethod: 'get', route, response: `I${name}Resource[]`, query: `I${name}CollectionQuery` },
        { name: 'resource', httpMethod: 'get', route, response: `I${name}Resource`, pathParam: idType },
        { name: 'create', httpMethod: 'post', route, response: `I${name}Resource`, body: `ICreate${name}Command` },
        { name: 'update', httpMethod: 'put', route, response: `I${name}Resource`, pathParam: idType, body: `IUpdate${name}Command` },
        { name: 'destroy', httpMethod: 'delete', route, response: 'never', pathParam: idType }
    ];
}
export async function generateFeature(options = {}, preset = false) {
    const fromFile = options.spec ? JSON.parse(await fs.readFile(path.resolve(options.spec), 'utf8')) : {};
    if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile))
        throw new Error('Feature spec must be an object.');
    const settings = { ...fromFile, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
    if (settings.idType !== undefined && settings.idType !== 'string' && settings.idType !== 'number')
        throw new Error('idType must be string or number.');
    for (const key of ['composition', 'presenter', 'schemas'])
        if (settings[key] !== undefined && typeof settings[key] !== 'boolean')
            throw new Error(key + ' must be boolean.');
    if (settings.types !== undefined && !Array.isArray(settings.types))
        throw new Error('types must be an array.');
    const rawContext = settings.context ?? (await selectContext('Select context for feature:'));
    if (!rawContext)
        return;
    const context = normalizePascalName(rawContext);
    if (context === 'SharedKernel')
        throw new Error('SharedKernel contains shared contracts, not generated aggregates.');
    const rawAggregate = settings.aggregate ?? (await selectAggregate(context));
    if (!rawAggregate)
        return;
    const aggregate = normalizePascalName(rawAggregate);
    const name = normalizePascalName(settings.name ?? aggregate);
    const route = settings.route ?? '/' + name.charAt(0).toLowerCase() + name.slice(1);
    let rawMethods = typeof settings.methods === 'string' ? JSON.parse(settings.methods) : settings.methods;
    if (!rawMethods)
        rawMethods = preset
            ? presetMethods(name, route, settings.idType)
            : [{ name: 'resource', httpMethod: 'get', route, response: `I${name}Resource` }];
    if (!Array.isArray(rawMethods) || !rawMethods.length)
        throw new Error('methods must be a non-empty array.');
    const names = new Set();
    const methods = rawMethods.map((m) => {
        if (!m || typeof m.name !== 'string' || !identifier(m.name) || names.has(m.name))
            throw new Error('Invalid/duplicate method name.');
        names.add(m.name);
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m.httpMethod) ||
            typeof m.route !== 'string' ||
            !m.route.startsWith('/'))
            throw new Error('Each method requires an HTTP method and an absolute route.');
        if (m.body && ['get', 'head', 'options'].includes(m.httpMethod))
            throw new Error('GET/HEAD/OPTIONS cannot carry a body.');
        if (m.pathParam && !['string', 'number'].includes(m.pathParam))
            throw new Error('pathParam must be string or number.');
        validType(m.response);
        for (const type of [m.query, m.body].filter((v) => v !== undefined))
            validType(type);
        return {
            name: m.name,
            httpMethod: m.httpMethod,
            route: m.route,
            response: { kind: /\bI[A-Z]/.test(m.response) ? 'domain' : 'primitive', type: m.response, layer: null },
            queryType: m.query ? { name: m.query, layer: 'DTO' } : null,
            bodyType: m.body ? { name: m.body, layer: 'DTO' } : null,
            pathParamType: m.pathParam ?? null
        };
    });
    const datasource = settings.datasource ? await resolveDatasource(settings.datasource) : await selectDatasource();
    if (!datasource)
        return;
    const meta = getRepositoryMeta(name);
    const repositoryFile = path.join(resolveRepositoriesPath(context, aggregate), meta.className + '.ts');
    for (const file of [
        repositoryFile,
        path.join(getAggregatePath(context, aggregate), 'Domain/Ports', meta.baseName + 'Repository.ts'),
        path.join(getAggregatePath(context, aggregate), 'Application/UseCases', meta.useCasesClassName + '.ts')
    ]) {
        if (await fs.access(file).then(() => true, () => false))
            throw new Error('Refusing to overwrite existing aggregate file: ' + file);
    }
    const types = settings.types ?? [
        { name: `I${name}Resource`, layer: 'Resources', fields: {} },
        ...(preset
            ? [
                { name: `I${name}CollectionQuery`, layer: 'DTO', fields: {} },
                { name: `ICreate${name}Command`, layer: 'DTO', fields: {} },
                { name: `IUpdate${name}Command`, layer: 'DTO', fields: {} }
            ]
            : [])
    ];
    const declarations = new Set();
    for (const type of types) {
        if (!type ||
            typeof type.name !== 'string' ||
            !/^I[A-Z][A-Za-z0-9]*$/.test(type.name) ||
            !['Resources', 'DTO'].includes(type.layer) ||
            (type.layer === 'Resources' && !type.name.endsWith('Resource')) ||
            declarations.has(type.name))
            throw new Error('Type declarations must be unique I-prefixed DTO/resource interfaces; resources end in Resource.');
        declarations.add(type.name);
        if (!type.fields || typeof type.fields !== 'object' || Array.isArray(type.fields))
            throw new Error('fields must be an object.');
        for (const [key, value] of Object.entries(type.fields)) {
            if (!/^[A-Za-z][A-Za-z0-9]*\??$/.test(key))
                throw new Error('Invalid field: ' + key);
            validType(value);
        }
    }
    // Reject unresolved domain references before writing any generated source.
    const existingTypes = await getDomainTypes(context, aggregate);
    const allTypes = [...existingTypes, ...types.map((t) => ({ name: t.name, layer: t.layer, fileName: t.name.slice(1) }))];
    const known = new Set(allTypes.map((t) => t.name));
    const expressions = [
        ...methods.flatMap((m) => [m.response.type, m.queryType?.name, m.bodyType?.name]),
        ...types.flatMap((t) => Object.values(t.fields))
    ];
    for (const expression of expressions) {
        if (!expression)
            continue;
        const source = ts.createSourceFile('Types.ts', `type Check = ${expression};`, ts.ScriptTarget.Latest, true);
        const visit = (node) => {
            if (ts.isTypeReferenceNode(node) &&
                ts.isIdentifier(node.typeName) &&
                /^I[A-Z]/.test(node.typeName.text) &&
                !known.has(node.typeName.text))
                throw new Error('Missing interface declaration: ' + node.typeName.text);
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    await ensureAggregateStructure(context, aggregate);
    for (const type of types) {
        const referenced = new Set();
        for (const expression of Object.values(type.fields)) {
            const source = ts.createSourceFile('Fields.ts', 'type Check = ' + expression + ';', ts.ScriptTarget.Latest, true);
            const visit = (node) => {
                if (ts.isTypeReferenceNode(node) &&
                    ts.isIdentifier(node.typeName) &&
                    node.typeName.text !== type.name &&
                    known.has(node.typeName.text))
                    referenced.add(node.typeName.text);
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
        const imports = [...referenced]
            .map((name) => {
            const target = allTypes.find((t) => t.name === name);
            return `import type { ${name} } from '${target.layer === type.layer ? './' : '../' + target.layer + '/'}${target.fileName}';`;
        })
            .join('\n');
        const fields = Object.entries(type.fields)
            .map(([key, value]) => ` ${key}: ${value};`)
            .join('\n');
        await writeIfNotExists(path.join(getAggregatePath(context, aggregate), 'Domain', type.layer, type.name.slice(1) + '.ts'), `${imports}${imports ? '\n\n' : ''}export interface ${type.name} {\n${fields || ' [key: string]: unknown;'}\n}\n`);
    }
    await ensureDomainScaffold(context, aggregate);
    await writeRepositoryInterface({ contextName: context, domainName: aggregate, meta, methods });
    await writeIfNotExists(repositoryFile, buildRepositoryContent({
        meta,
        contextAlias: '#contexts/' + context,
        domainName: aggregate,
        datasource,
        methods,
        domainTypes: await getDomainTypes(context, aggregate)
    }));
    await createUseCasesForRepository({
        contextName: context,
        contextAlias: '#contexts/' + context,
        domainName: aggregate,
        repositoryName: meta.className
    });
    const registration = { context, aggregate, repository: meta.className, datasource: datasource.name };
    let wired = false;
    if (settings.composition === true) {
        await wireComposition(registration);
        wired = true;
    }
    else if (settings.composition === undefined)
        wired = await prepareComposition(registration);
    else {
        const { printApplicationProviderWiring } = await import('./repositoryModuleShared.js');
        printApplicationProviderWiring(context, meta.className, datasource.name, aggregate);
    }
    if (!wired || settings.presenter === false)
        return;
    const workspace = settings.boundary
        ? { name: normalizePascalName(settings.boundary), path: getPresentationPath(settings.boundary) }
        : undefined;
    await generatePresenter({
        contextName: context,
        aggregateName: aggregate,
        useCasesName: meta.useCasesClassName,
        workspace,
        scope: settings.scope ? normalizePascalName(settings.scope) : undefined,
        presenterName: name + 'Presenter',
        schemas: settings.schemas ?? false
    });
}
export default generateFeature;
