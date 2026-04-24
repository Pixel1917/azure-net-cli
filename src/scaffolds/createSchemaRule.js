import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase, toCamelCase } from '../utils/contextUtils.js';

const createSchemaRuleTemplate = (ruleName) => `import type { ValidationParams, ValidationRuleResult } from '@azure-net/kit/delivery';

export const ${ruleName} = <T = unknown, D = unknown>(): ValidationRuleResult<T, D> => {
\treturn (validationParams: ValidationParams<T, D>) => {
\t\treturn undefined;
\t};
};
`;

export default async function createSchemaRule() {
	const { ruleNameRaw } = await prompts({
		type: 'text',
		name: 'ruleNameRaw',
		message: 'Schema rule name:',
		initial: 'File'
	});

	const pascalName = toPascalCase(String(ruleNameRaw ?? 'File')) || 'File';
	const camelName = toCamelCase(pascalName) || 'file';
	const rulesPath = path.join(process.cwd(), 'src', 'core', 'schema', 'custom-rules');
	const filePath = path.join(rulesPath, `${pascalName}.ts`);

	await fs.mkdir(rulesPath, { recursive: true });

	const created = await writeIfNotExists(filePath, createSchemaRuleTemplate(camelName));
	await updateIndexTs(rulesPath);

	if (!created) {
		console.log(`⚠️ Schema rule "${pascalName}" already exists. File was not overwritten.`);
		return;
	}

	console.log(`✅ Schema rule created: ${filePath}`);
}
