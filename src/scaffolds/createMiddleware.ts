import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { writeIfNotExists, updateIndexTs } from '../utils/fileUtils.js';
import { toPascalCase } from '../utils/contextUtils.js';

const createMiddlewareTemplate = (middlewareName: string): string => `import { type IMiddleware } from '@azure-net/kit';

export const ${middlewareName}: IMiddleware = async ({ next }) => {
\treturn next();
};
`;

const addMiddlewareToManager = (content: string, middlewareName: string): string => {
	const wordRegex = new RegExp(`\\b${middlewareName}\\b`);
	if (wordRegex.test(content)) return content;

	const importLine = `import { ${middlewareName} } from './middlewares';`;
	if (!content.includes(importLine)) {
		const importMatches = Array.from(content.matchAll(/^import[^\n]*$/gm));
		const lastImport = importMatches.at(-1);
		if (lastImport) {
			const insertPos = (lastImport.index ?? 0) + lastImport[0].length;
			content = `${content.slice(0, insertPos)}\n${importLine}${content.slice(insertPos)}`;
		} else {
			content = `${importLine}\n${content}`;
		}
	}

	const managerCallRegex = /createMiddlewareManager\s*\(\s*\[([\s\S]*?)\]\s*\)/m;
	const match = content.match(managerCallRegex);
	if (!match) return content;

	const arrayBody = match[1] ?? '';
	if (wordRegex.test(arrayBody)) return content;

	const isMultiline = arrayBody.includes('\n');
	const hasItems = arrayBody.trim().length > 0;

	if (!isMultiline) {
		const trimmed = arrayBody.trim();
		const nextArrayBody = hasItems ? `${trimmed}, ${middlewareName}` : middlewareName;
		return content.replace(managerCallRegex, `createMiddlewareManager([${nextArrayBody}])`);
	}

	if (!hasItems) {
		const baseIndent = arrayBody.match(/\n([ \t]*)$/)?.[1] ?? '\t';
		const nextArrayBody = `\n${baseIndent}${middlewareName}\n`;
		return content.replace(managerCallRegex, `createMiddlewareManager([${nextArrayBody}])`);
	}

	const trimmedBody = arrayBody.trimEnd();
	const lastItemIndent = trimmedBody.match(/(?:^|\n)([ \t]*)\S[^\n]*$/)?.[1] ?? '\t';
	const nextArrayBody = `${trimmedBody},\n${lastItemIndent}${middlewareName}\n`;

	return content.replace(managerCallRegex, `createMiddlewareManager([${nextArrayBody}])`);
};

export default async function createMiddleware(): Promise<void> {
	const { middlewareNameRaw } = await prompts({
		type: 'text',
		name: 'middlewareNameRaw',
		message: 'Middleware name:',
		initial: 'RoutesGuard'
	});

	const middlewareName = toPascalCase(String(middlewareNameRaw ?? 'RoutesGuard')) || 'RoutesGuard';
	const middlewareManagerPath = path.join(process.cwd(), 'src', 'core', 'middleware-manager');
	const middlewaresPath = path.join(middlewareManagerPath, 'middlewares');
	const middlewareFilePath = path.join(middlewaresPath, `${middlewareName}.ts`);
	const middlewaresIndexPath = path.join(middlewaresPath, 'index.ts');
	const middlewareManagerFile = path.join(middlewareManagerPath, 'MiddlewareManager.ts');

	await fs.mkdir(middlewaresPath, { recursive: true });

	const created = await writeIfNotExists(middlewareFilePath, createMiddlewareTemplate(middlewareName));
	await updateIndexTs(middlewaresPath);

	if (!created) {
		console.log(`⚠️ Middleware "${middlewareName}" already exists. File was not overwritten.`);
		return;
	}

	let managerContent: string;
	try {
		managerContent = await fs.readFile(middlewareManagerFile, 'utf-8');
	} catch {
		console.log(`⚠️ Middleware manager not found at ${middlewareManagerFile}. Run "azure-net create middleware-manager" first.`);
		return;
	}

	const nextManagerContent = addMiddlewareToManager(managerContent, middlewareName);
	await fs.writeFile(middlewareManagerFile, nextManagerContent, 'utf-8');

	const hasIndex = await fs
		.access(middlewaresIndexPath)
		.then(() => true)
		.catch(() => false);

	console.log(`✅ Middleware created: ${middlewareFilePath}`);
	if (hasIndex) {
		console.log(`✅ Middlewares index updated: ${middlewaresIndexPath}`);
	}
	console.log(`✅ Middleware manager updated: ${middlewareManagerFile}`);
}
