import fs from 'fs/promises';
import path from 'path';
import { toPascalCase, toCamelCase } from './contextUtils.js';
import { writeIfNotExists, updateIndexTs } from './fileUtils.js';

export async function ensureProvider(context, layer, dependencies = {}) {
    const contextName = toPascalCase(context);
    const providerName = `${layer}Provider`;
    const boundaryName = `${contextName}${layer}BoundaryProvider`;

    const contextPath = path.join(process.cwd(), 'src/app/contexts', context);
    const providerPath = path.join(contextPath, layer, 'Providers', `${layer}Provider.ts`);

    try {
        await fs.access(providerPath);
        return { exists: true, name: providerName, path: providerPath };
    } catch {
        // Provider doesn't exist, create it
        const content = generateProviderContent(context, layer, dependencies);
        await writeIfNotExists(providerPath, content);
        await updateIndexTs(path.dirname(providerPath));

        // Update layer index to export provider
        const layerIndexPath = path.join(contextPath, layer, 'index.ts');
        await writeIfNotExists(layerIndexPath, `export { ${providerName} } from './Providers';`);

        return { exists: false, name: providerName, path: providerPath };
    }
}

function generateProviderContent(context, layer, dependencies) {
    const contextName = toPascalCase(context);
    const boundaryName = `${contextName}${layer}BoundaryProvider`;
    const varName = `${layer}Provider`;

    let imports = [`import { createBoundaryProvider } from '@azure-net/kit';`];
    let deps = [];

    if (dependencies.hasDatasource && layer === 'Infrastructure') {
        imports.push(`import { DatasourceProvider } from './DatasourceProvider';`);
        deps.push('DatasourceProvider');
    }

    if (dependencies.infrastructure && layer === 'Application') {
        imports.push(`import { InfrastructureProvider } from '\$${context}/Infrastructure';`);
        deps.push('InfrastructureProvider');
    }

    const depParams = deps.length > 0 ? `{ ${deps.join(', ')} }` : '';
    const dependsOnStr = deps.length > 0
        ? `,\n\t{ dependsOn: { ${deps.join(', ')} } }`
        : '';

    return `${imports.join('\n')}

export const ${varName} = createBoundaryProvider(
\t'${boundaryName}',
\t(${depParams}) => ({
\t\t// Services will be added here
\t})${dependsOnStr}
);`;
}

export async function addToProvider(providerPath, serviceName, importPath, dependency = null) {
    let content = await fs.readFile(providerPath, 'utf-8');

    // Parse existing imports to group them
    const importRegex = /^import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/gm;
    const imports = new Map();
    let match;

    while ((match = importRegex.exec(content)) !== null) {
        const [fullMatch, importedItems, fromPath] = match;
        if (!imports.has(fromPath)) {
            imports.set(fromPath, new Set());
        }
        importedItems.split(',').forEach(item => {
            imports.get(fromPath).add(item.trim());
        });
    }

    // Add new import to the map
    if (!Array.from(imports.values()).some(set => set.has(serviceName))) {
        if (!imports.has(importPath)) {
            imports.set(importPath, new Set());
        }
        imports.get(importPath).add(serviceName);
    }

    // Rebuild import section
    const newImports = [`import { createBoundaryProvider } from '@azure-net/kit';`];

    // Add DatasourceProvider import if exists
    if (content.includes('DatasourceProvider') && !content.includes("import { DatasourceProvider }")) {
        newImports.push(`import { DatasourceProvider } from './DatasourceProvider';`);
    }

    // Add other imports
    for (const [fromPath, items] of imports) {
        if (fromPath !== '@azure-net/kit' && !fromPath.includes('DatasourceProvider')) {
            const itemsStr = Array.from(items).join(', ');
            newImports.push(`import { ${itemsStr} } from '${fromPath}';`);
        }
    }

    // Find where imports end and provider starts
    const providerStartIndex = content.indexOf('export const');
    const beforeProvider = content.substring(0, providerStartIndex);
    const afterProvider = content.substring(providerStartIndex);

    // Check if DatasourceProvider dependency needs to be added
    let updatedAfterProvider = afterProvider;
    if (dependency && dependency.includes('DatasourceProvider')) {
        // Check if provider already has dependencies
        if (!afterProvider.includes('({ DatasourceProvider })')) {
            // Add DatasourceProvider to function params
            updatedAfterProvider = updatedAfterProvider.replace(
                /createBoundaryProvider\(\s*'[^']+',\s*\(\)/,
                `createBoundaryProvider(\n\t'$1',\n\t({ DatasourceProvider })`
            );

            // Add dependsOn if not exists
            if (!updatedAfterProvider.includes('dependsOn')) {
                updatedAfterProvider = updatedAfterProvider.replace(
                    /\)\s*\);$/,
                    `),\n\t{ dependsOn: { DatasourceProvider } }\n);`
                );
            }
        }
    }

    // Add factory method with dependency
    const factoryLine = dependency
        ? `\t\t${serviceName}: () => new ${serviceName}(${dependency})`
        : `\t\t${serviceName}: () => new ${serviceName}()`;

    if (!updatedAfterProvider.includes(`${serviceName}:`)) {
        // Find the position to insert
        const returnIndex = updatedAfterProvider.indexOf('=> ({');
        const endOfReturn = updatedAfterProvider.indexOf('\t})', returnIndex);

        // Check if there are existing services
        const servicesSection = updatedAfterProvider.substring(returnIndex, endOfReturn);
        const hasServices = servicesSection.includes(':') && !servicesSection.includes('// Services will be added here');

        if (hasServices) {
            // Add comma before new service
            const beforeEnd = updatedAfterProvider.lastIndexOf('\n', endOfReturn);
            updatedAfterProvider = updatedAfterProvider.slice(0, beforeEnd) + ',\n' + factoryLine + updatedAfterProvider.slice(beforeEnd);
        } else {
            // First service, replace comment
            updatedAfterProvider = updatedAfterProvider.replace(
                '// Services will be added here',
                factoryLine
            );
        }
    }

    // Combine everything
    const finalContent = newImports.join('\n') + '\n\n' + updatedAfterProvider;
    await fs.writeFile(providerPath, finalContent, 'utf-8');
}

export async function ensureDatasourceProvider(context, datasourceName, isFromCore = true) {
    const contextName = toPascalCase(context);
    const contextPath = path.join(process.cwd(), 'src/app/contexts', context);
    const providerPath = path.join(contextPath, 'Infrastructure/Providers/DatasourceProvider.ts');

    try {
        await fs.access(providerPath);
        // Provider exists, add datasource if needed
        await addDatasourceToProvider(providerPath, datasourceName, isFromCore);
    } catch {
        // Create new DatasourceProvider
        const content = `import { createBoundaryProvider } from '@azure-net/kit';
import { ${datasourceName} } from '${isFromCore ? '$core' : '../Http/Datasource'}';

export const DatasourceProvider = createBoundaryProvider('${contextName}DatasourceProvider', () => ({
\t${datasourceName}: () => new ${datasourceName}({})
}));`;

        await writeIfNotExists(providerPath, content);
        await updateIndexTs(path.dirname(providerPath));
    }
}

async function addDatasourceToProvider(providerPath, datasourceName, isFromCore = true) {
    let content = await fs.readFile(providerPath, 'utf-8');

    // Check if datasource already exists
    if (content.includes(`${datasourceName}:`)) {
        return;
    }

    // Parse existing imports to group them
    const importRegex = /^import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/gm;
    const imports = new Map();
    let match;

    while ((match = importRegex.exec(content)) !== null) {
        const [fullMatch, importedItems, fromPath] = match;
        if (!imports.has(fromPath)) {
            imports.set(fromPath, new Set());
        }
        importedItems.split(',').forEach(item => {
            imports.get(fromPath).add(item.trim());
        });
    }

    // Add datasource to imports
    const importPath = isFromCore ? '$core' : '../Http/Datasource';
    if (!imports.has(importPath)) {
        imports.set(importPath, new Set());
    }
    imports.get(importPath).add(datasourceName);

    // Rebuild import section
    const newImports = [`import { createBoundaryProvider } from '@azure-net/kit';`];
    for (const [fromPath, items] of imports) {
        if (fromPath !== '@azure-net/kit') {
            const itemsStr = Array.from(items).join(', ');
            newImports.push(`import { ${itemsStr} } from '${fromPath}';`);
        }
    }

    // Find provider content
    const providerStartIndex = content.indexOf('export const');
    const afterProvider = content.substring(providerStartIndex);

    // Add factory method
    const factoryLine = `\t${datasourceName}: () => new ${datasourceName}({})`;

    const returnIndex = afterProvider.indexOf('=> ({');
    const endOfReturn = afterProvider.indexOf('})', returnIndex);

    // Check if there are existing services
    const servicesSection = afterProvider.substring(returnIndex, endOfReturn);
    const hasServices = servicesSection.includes(':');

    let updatedAfterProvider = afterProvider;
    if (hasServices) {
        // Add comma before new service
        const beforeEnd = updatedAfterProvider.lastIndexOf('\n', endOfReturn);
        updatedAfterProvider = updatedAfterProvider.slice(0, beforeEnd) + ',\n' + factoryLine + updatedAfterProvider.slice(beforeEnd);
    } else {
        // First service
        const insertPoint = returnIndex + '=> ({\n'.length;
        updatedAfterProvider = updatedAfterProvider.slice(0, insertPoint) + factoryLine + '\n' + updatedAfterProvider.slice(insertPoint);
    }

    // Combine everything
    const finalContent = newImports.join('\n') + '\n\n' + updatedAfterProvider;
    await fs.writeFile(providerPath, finalContent, 'utf-8');
}