// Test TypeScript sources without emitting generated JavaScript into the working tree.
import fs from 'node:fs/promises';
import ts from 'typescript';
export async function load(url, context, nextLoad) {
	if (url.startsWith('file:') && url.endsWith('.js') && !url.includes('/node_modules/')) {
		try {
			const source = await fs.readFile(new URL(url.slice(0, -3) + '.ts'), 'utf8');
			return {
				format: 'module',
				shortCircuit: true,
				source: ts.transpileModule(source, {
					compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
				}).outputText
			};
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	return nextLoad(url, context);
}
export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		if (specifier.endsWith('.js') && specifier.startsWith('.')) {
			const url = new URL(specifier, context.parentURL).href;
			await fs.access(new URL(url.slice(0, -3) + '.ts'));
			return { url, shortCircuit: true };
		}
		throw error;
	}
}
