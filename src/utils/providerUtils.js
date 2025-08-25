import fs from 'fs/promises';
import path from 'path';
import { toPascalCase, toCamelCase } from './contextUtils.js';
import { writeIfNotExists, updateIndexTs } from './fileUtils.js';

export async function ensureProvider(context, layer, dependencies = {}) {
    const providerName = `${toPascalCase(context)}${layer}Provider`;
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
        await updateIndexTs(path.join(contextPath, layer));
        return { exists: false, name: providerName, path: providerPath };
    }
}

function generateProviderContent(context, layer, dependencies) {
    const providerName = `${toPascalCase(context)}${layer}BoundaryProvider`;
    const varName = `${layer}Provider`;

    let imports = [`import { createBoundaryProvider } from '@azure-net/kit';`];
    let deps = [];
    let factories = [];

    if (dependencies.datasource && layer === 'Infrastructure') {
        imports.push(`import { ${dependencies.datasource} } from '../Datasources/index.js';`);
        factories.push(`\t${dependencies.datasource}: () => new ${dependencies.datasource}()`);
    }

    if (dependencies.infrastructure && layer === 'Application') {
        imports.push(`import { InfrastructureProvider } from '../../Infrastructure/index.js';`);
        deps.push('InfrastructureProvider');
    }

    const dependsOnStr = deps.length > 0
        ? `,\n\t{ dependsOn: { ${deps.join(', ')} } }`
        : '';

    return `${imports.join('\n')}

export const ${varName} = createBoundaryProvider(
\t'${providerName}',
\t(${deps.length > 0 ? `{ ${deps.join(', ')} }` : ''}) => ({
${factories.join(',\n')}
\t})${dependsOnStr}
);`;
}

export async function addToProvider(providerPath, serviceName, importPath) {
    let content = await fs.readFile(providerPath, 'utf-8');

    // Add import if not exists
    const importStatement = `import { ${serviceName} } from '${importPath}';`;
    if (!content.includes(importStatement)) {
        const lastImportIndex = content.lastIndexOf('import ');
        const endOfImportLine = content.indexOf('\n', lastImportIndex);
        content = content.slice(0, endOfImportLine + 1) + importStatement + '\n' + content.slice(endOfImportLine + 1);
    }

    // Add factory method
    const factoryLine = `\t\t${serviceName}: () => new ${serviceName}()`;
    const returnIndex = content.indexOf('=> ({');
    const endOfReturn = content.indexOf('\t})', returnIndex);

    if (!content.includes(factoryLine)) {
        const beforeEnd = content.lastIndexOf('\n', endOfReturn);
        content = content.slice(0, beforeEnd) + ',\n' + factoryLine + content.slice(beforeEnd);
    }

    await fs.writeFile(providerPath, content, 'utf-8');
}