import prompts from 'prompts';
import path from 'path';
import { selectContext, getContextPath, toPascalCase, getAvailableFiles } from '../../utils/contextUtils.js';
import { writeIfNotExists, updateIndexTs } from '../../utils/fileUtils.js';

const schemaWithCoreTemplate = `import { {{coreSchema}} } from '$core/Schema';
import type { I{{name}}Request } from '${{context}}/Domain/Ports/{{entity}}';

export const {{name}}Schema = {{coreSchema}}<I{{name}}Request>()
\t.rules((rules) => ({
\t\t// Add validation rules here
\t}))
\t.create();`;

const schemaWithPackageTemplate = `import { createSchemaFactory } from '@azure-net/kit';
import { createRules, validationMessagesI18n } from '@azure-net/kit/schema';
import type { I{{name}}Request } from '${{context}}/Domain/Ports/{{entity}}';

const Schema = createSchemaFactory(createRules(validationMessagesI18n));

export const {{name}}Schema = Schema<I{{name}}Request>()
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

    const { module } = await prompts({
        type: 'text',
        name: 'module',
        message: 'Module name (folder in Delivery):'
    });

    const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: 'Schema name (without "Schema" suffix):'
    });

    // Check for core schemas
    const coreSchemas = await getAvailableFiles(
        path.join(process.cwd(), 'src/app/core/Schema')
    );

    const choices = [
        { title: 'Use createSchemaFactory from package', value: 'package' },
        ...coreSchemas.map(s => ({ title: `Use ${s} from core`, value: s }))
    ];

    const { schemaType } = await prompts({
        type: 'select',
        name: 'schemaType',
        message: 'Select schema factory:',
        choices
    });

    const pascalName = toPascalCase(name);
    const moduleName = toPascalCase(module);
    const contextPath = getContextPath(context);
    const schemaPath = path.join(contextPath, 'Delivery', moduleName, 'Schema');
    const filePath = path.join(schemaPath, `${pascalName}Schema.ts`);

    const content = schemaType === 'package'
        ? schemaWithPackageTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{entity}}/g, moduleName)
        : schemaWithCoreTemplate
            .replace(/{{name}}/g, pascalName)
            .replace(/{{context}}/g, context)
            .replace(/{{entity}}/g, moduleName)
            .replace(/{{coreSchema}}/g, schemaType);

    await writeIfNotExists(filePath, content);
    await updateIndexTs(schemaPath);

    // Update module index
    const moduleIndexPath = path.join(contextPath, 'Delivery', moduleName, 'index.ts');
    if (await fs.access(moduleIndexPath).then(() => true).catch(() => false)) {
        let indexContent = await fs.readFile(moduleIndexPath, 'utf-8');
        if (!indexContent.includes(`export * from './Schema'`)) {
            indexContent += `\nexport * from './Schema';`;
            await fs.writeFile(moduleIndexPath, indexContent, 'utf-8');
        }
    }

    console.log(`✅ Schema created at ${filePath}`);
}