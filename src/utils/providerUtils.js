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
    let depParams = '';

    if (dependencies.hasDatasource && layer === 'Infrastructure') {
        imports.push(`import { DatasourceProvider } from './DatasourceProvider';`);
        deps.push('DatasourceProvider');
    }

    if (dependencies.infrastructure && layer === 'Application') {
        imports.push(`import { InfrastructureProvider } from '\$${context}/Infrastructure';`);
        deps.push('InfrastructureProvider');
    }

    if (deps.length > 0) {
        depParams = `{ ${deps.join(', ')} }`;
    }

    const dependsOnStr = deps.length > 0
        ? `,\n\t{ dependsOn: { ${deps.join(', ')} } }`
        : '';

    return `${imports.join('\n')}

export const ${varName} = createBoundaryProvider(
\t'${boundaryName}',
\t(${depParams ? depParams : ''}) => ({
\t\t// Services will be added here
\t})${dependsOnStr}
);`;
}

export async function addToProvider(providerPath, serviceName, importPath, dependency = null) {
    let content = await fs.readFile(providerPath, 'utf-8');

    // Add import if not exists
    const importStatement = `import { ${serviceName} } from '${importPath}';`;
    if (!content.includes(serviceName)) {
        const lastImportIndex = content.lastIndexOf('import ');
        const endOfImportLine = content.indexOf('\n', lastImportIndex);
        content = content.slice(0, endOfImportLine + 1) + importStatement + '\n' + content.slice(endOfImportLine + 1);
    }

    // Add factory method with dependency
    const factoryLine = dependency
        ? `\t\t${serviceName}: () => new ${serviceName}(${dependency})`
        : `\t\t${serviceName}: () => new ${serviceName}()`;

    if (!content.includes(`${serviceName}:`)) {
        // Find the position to insert
        const returnIndex = content.indexOf('=> ({');
        const endOfReturn = content.indexOf('\t})', returnIndex);

        // Check if there are existing services
        const servicesSection = content.substring(returnIndex, endOfReturn);
        const hasServices = servicesSection.includes(':');

        if (hasServices) {
            // Add comma before new service
            const beforeEnd = content.lastIndexOf('\n', endOfReturn);
            content = content.slice(0, beforeEnd) + ',\n' + factoryLine + content.slice(beforeEnd);
        } else {
            // First service, replace comment
            content = content.replace(
                '// Services will be added here',
                factoryLine
            );
        }
    }

    await fs.writeFile(providerPath, content, 'utf-8');
}