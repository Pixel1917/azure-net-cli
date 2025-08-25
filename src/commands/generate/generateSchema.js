import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const schemaWithCoreTemplate = `import { {{coreSchema}} } from '$core/Schemas/index.js';
import type { I{{name}}Request } from '../../Domain/Ports/{{name}}/index.js';

export const {{name}}Schema = {{coreSchema}}<I{{name}}Request>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const schemaWithPackageTemplate = `import { schema } from '@azure-net/kit';
import type { I{{name}}Request } from '../../Domain/Ports/{{name}}/index.js';

export const {{name}}Schema = schema<I{{name}}Request>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

export default async function generateSchema() {
    const context = await selectContext('Select context for schema:');

    if (context === 'core') {
        console.error('❌ Cannot create schema in core. Choose a specific context.');
        return;
    }

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Schema name (without "Schema" suffix):'
    });

    // Check for core schemas
    const coreSchemas = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Schemas')
    );

    const choices = [
        { title: 'Use schema from package', value: 'package' },
        ...coreSchemas.map(s => ({ title: `Use ${s} from core`, value: s }))
    ];

    const { schemaType } = await prompts({
        type: 'select',
        name: 'schemaType',
        message: 'Select schema factory:',
        choices
    });

    const pascalName = toPascalCase(name);
    const contextPath = getContextPath(context);
    const schemaPath = path.join(contextPath, 'Delivery', 'Schemas');
    const filePath = path.join(schemaPath, `${pascalName}Schema.ts`);

    const content = schemaType === 'package'
        ? schemaWithPackageTemplate.replace(/{{name}}/g, pascalName)
        : schemaWithCoreTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{coreSchema}}/g, schemaType);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(schemaPath);

    console.log(`✅ Schema created at ${filePath}`);
}