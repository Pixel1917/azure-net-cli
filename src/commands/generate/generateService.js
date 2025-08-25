import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';
import { ensureProvider, addToProvider } from '../../utils/providerUtils.js';

const serviceTemplate = `import { ClassMirror } from '@azure-net/kit';
import { {{repository}} } from '../../Infrastructure/Repositories/index.js';

export class {{name}}Service extends ClassMirror<{{repository}}> {
\tconstructor(private {{repositoryVar}}: {{repository}}) {
\t\tsuper({{repositoryVar}});
\t}
\t
\tdeclare example: {{repository}}['example'];
}`;

const serviceWithoutRepoTemplate = `export class {{name}}Service {
\tconstructor() {}
\t
\tpublic async example() {
\t\t// Implement service logic
\t\treturn {};
\t}
}`;

export default async function generateService() {
    const context = await selectContext('Select context for service:');

    if (context === 'core') {
        console.error('❌ Cannot create service in core. Choose a specific context.');
        return;
    }

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Service name (without "Service" suffix):'
    });

    // Get available repositories
    const contextPath = getContextPath(context);
    const repositories = await getAvailableFiles(
        path.join(contextPath, 'Infrastructure', 'Repositories')
    );

    const choices = [
        { title: 'Without repository', value: null },
        ...repositories.map(r => ({ title: `${r}Repository`, value: `${r}Repository` }))
    ];

    const { repository } = await prompts({
        type: 'select',
        name: 'repository',
        message: 'Select repository:',
        choices
    });

    const pascalName = toPascalCase(name);
    const servicePath = path.join(contextPath, 'Application', 'Services');
    const filePath = path.join(servicePath, `${pascalName}Service.ts`);

    // Generate service
    const content = repository
        ? serviceTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{repository}}/g, repository)
            .replace(/{{repositoryVar}}/g, repository.charAt(0).toLowerCase() + repository.slice(1))
        : serviceWithoutRepoTemplate.replace(/{{name}}/g, pascalName);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(servicePath);

    // Ensure ApplicationProvider exists and add service
    const appProvider = await ensureProvider(context, 'Application', { infrastructure: true });
    await addToProvider(
        appProvider.path,
        `${pascalName}Service`,
        '../Services/index.js'
    );

    // Add repository dependency if selected
    if (repository) {
        let providerContent = await fs.readFile(appProvider.path, 'utf-8');
        const serviceFactory = `${pascalName}Service: () => new ${pascalName}Service()`;
        const serviceWithRepo = `${pascalName}Service: () => new ${pascalName}Service(InfrastructureProvider.${repository})`;
        providerContent = providerContent.replace(serviceFactory, serviceWithRepo);
        await fs.writeFile(appProvider.path, providerContent, 'utf-8');
    }

    console.log(`✅ Service created at ${filePath}`);
}