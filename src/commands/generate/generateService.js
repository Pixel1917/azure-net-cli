import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const serviceTemplate = `import { ClassMirror } from '@azure-net/kit';
import { {{repository}} } from '\${{context}}/infrastructure/http/repositories';

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

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Service name (without "Service" suffix):'
    });

    // Get available repositories
    const contextPath = getContextPath(context);
    const repositories = await getAvailableFiles(
        path.join(contextPath, 'infrastructure', 'http', 'repositories')
    );

    const choices = [
        { title: 'Without repository', value: null },
        ...repositories.map(r => ({ title: `${r}`, value: r }))
    ];

    const { repository } = await prompts({
        type: 'select',
        name: 'repository',
        message: 'Select repository:',
        choices
    });

    const pascalName = toPascalCase(name);
    const servicePath = path.join(contextPath, 'application', 'services');
    const filePath = path.join(servicePath, `${pascalName}Service.ts`);

    // Generate service
    const content = repository
        ? serviceTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{repository}}/g, repository)
            .replace(/{{repositoryVar}}/g, repository.charAt(0).toLowerCase() + repository.slice(1))
            .replace(/{{context}}/g, context)
        : serviceWithoutRepoTemplate.replace(/{{name}}/g, pascalName);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(servicePath);

    console.log(`✅ Service created at ${filePath}`);
    console.log(`\n💡 Remember to manually add this service to ApplicationProvider when needed.`);
}