import { writeIfNotExists, updateCoreIndex } from '../../utils/fileUtils.js';
import path from 'path';

const schemaPath = path.join(process.cwd(), 'src/app/core/schemas/Schema.ts');

const schemaTemplate = `import { createSchemaFactory } from '@azure-net/kit';
import { createRules, validationMessagesI18n } from '@azure-net/kit/schema';

export const Schema = createSchemaFactory(createRules(validationMessagesI18n));`;

export default async function initSchema() {
    await writeIfNotExists(schemaPath, schemaTemplate);
    await writeIfNotExists(
        path.join(process.cwd(), 'src/app/core/schemas/index.ts'),
        `export * from './Schema';`
    );

    // Update core index
    await updateCoreIndex();

    console.log('✅ Schema factory initialized');
}