import prompts from 'prompts';
import path from 'path';
import fs from 'fs/promises';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const serviceTemplate = `import { ClassMirror } from '@azure-net/kit';
import { {{repository}} } from '\${{context}}/Infrastructure/Http/Repositories';

export class {{name}}Service extends ClassMirror<{{repository}}> {
\tconstructor(private {{repositoryVar}}: {{repository}}) {
\t\tsuper({{repositoryVar}});
\t}
\t
{{methodDeclarations}}
}`;

export default async function generateServiceByRepo() {
    const context = await selectContext('Select context:');

    const contextPath = getContextPath(context);
    const repositories = await getAvailableFiles(
        path.join(contextPath, 'Infrastructure/Http/Repositories')
    );

    if (repositories.length === 0) {
        console.error('❌ No repositories available. Create a repository first.');
        return;
    }

    const { repository } = await prompts({
        type: 'select',
        name: 'repository',
        message: 'Select repository to create service from:',
        choices: repositories.map(r => ({ title: r, value: r }))
    });

    const serviceName = repository.replace('Repository', 'Service');
    const servicePath = path.join(contextPath, 'Application/Services');
    const filePath = path.join(servicePath, `${serviceName}.ts`);

    // Try to get repository file to extract methods
    const repoFilePath = path.join(contextPath, 'Infrastructure/Http/Repositories', `${repository}.ts`);
    let methodDeclarations = '';

    try {
        const repoContent = await fs.readFile(repoFilePath, 'utf-8');
        // Extract public methods from repository
        const methodRegex = /public async (\w+)\([^)]*\)(?:\s*:\s*[^{]+)?/g;
        const methods = [];
        let match;

        while ((match = methodRegex.exec(repoContent)) !== null) {
            methods.push(match[1]);
        }

        if (methods.length > 0) {
            methodDeclarations = methods
                .map(m => `\tdeclare ${m}: ${repository}['${m}'];`)
                .join('\n');
        } else {
            // Fallback to common CRUD methods
            methodDeclarations = [
                'collection', 'resource', 'create', 'update', 'remove'
            ].map(m => `\tdeclare ${m}: ${repository}['${m}'];`).join('\n');
        }
    } catch (error) {
        // Fallback if can't read repository file
        methodDeclarations = [
            'collection', 'resource', 'create', 'update', 'remove'
        ].map(m => `\tdeclare ${m}: ${repository}['${m}'];`).join('\n');
    }

    const content = serviceTemplate
        .replace(/{{name}}/g, serviceName.replace('Service', ''))
        .replace(/{{repository}}/g, repository)
        .replace(/{{repositoryVar}}/g, repository.charAt(0).toLowerCase() + repository.slice(1))
        .replace(/{{context}}/g, context)
        .replace(/{{methodDeclarations}}/g, methodDeclarations);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(servicePath);

    console.log(`✅ Service created at ${filePath}`);
    console.log(`\n💡 Remember to manually add this service to ApplicationProvider when needed.`);
}