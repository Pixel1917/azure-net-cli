import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { flattenConfigLiterals } from './flattenConfig.js';

export type AzureNetConfig = {
	appBoundaries?: string[];
	presentationWorkspaces?: string[];
	runChecksBeforePush?: boolean;
	packageManager?: string;
	defaultSchemaFactory?: string;
	groupRoutesFunc?: unknown;
	[key: string]: unknown;
};

export function resolveConfigFile(cwd = process.cwd()): { exists: boolean; filepath: string; type: 'ts' | 'js' } {
	for (const type of ['ts', 'js'] as const) {
		const filepath = path.join(cwd, `azure-net.config.${type}`);
		if (fsSync.existsSync(filepath)) return { exists: true, filepath, type };
	}
	return { exists: false, filepath: path.join(cwd, 'azure-net.config.ts'), type: 'ts' };
}

export async function loadUserConfig(cwd = process.cwd()): Promise<AzureNetConfig> {
	const { exists, filepath } = resolveConfigFile(cwd);
	if (!exists) return {};
	try {
		const source = await fs.readFile(filepath, 'utf8');
		const result = ts.transpileModule(source, {
			fileName: filepath,
			reportDiagnostics: true,
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
		});
		const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
		if (errors.length) throw new Error(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
		const module: { exports: Record<string, unknown> } = { exports: {} };
		new Function('module', 'exports', 'require', '__filename', '__dirname', result.outputText)(
			module,
			module.exports,
			createRequire(filepath),
			filepath,
			path.dirname(filepath)
		);
		const config = module.exports.default;
		if (!config || typeof config !== 'object' || Array.isArray(config))
			throw new Error('Expected a default-exported configuration object.');
		const parsed = config as AzureNetConfig;
		for (const key of ['appBoundaries', 'presentationWorkspaces'] as const) {
			const names = parsed[key];
			if (
				names !== undefined &&
				(!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !/^[A-Z][A-Za-z0-9]*$/.test(name)))
			)
				throw new Error(`${key} must be an array of PascalCase boundary names.`);
		}
		if (parsed.runChecksBeforePush !== undefined && typeof parsed.runChecksBeforePush !== 'boolean')
			throw new Error('runChecksBeforePush must be a boolean.');
		return parsed;
	} catch (error) {
		throw new Error(`Unable to load ${filepath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/** Add the default without rewriting or dropping legacy/user configuration. */
export async function initializeConfigDefaults(cwd = process.cwd()): Promise<void> {
	const existing = resolveConfigFile(cwd);
	if (existing.exists) {
		const original = await fs.readFile(existing.filepath, 'utf8');
		const flattened = flattenConfigLiterals(original);
		if (flattened !== original) await fs.writeFile(existing.filepath, flattened);
	}
	const config = await loadUserConfig(cwd);
	if (config.runChecksBeforePush !== undefined) return;
	const resolved = resolveConfigFile(cwd);
	if (!resolved.exists) {
		await fs.writeFile(resolved.filepath, "export default {\n\tappBoundaries: ['Public'],\n\trunChecksBeforePush: true\n};\n", {
			flag: 'wx'
		});
		return;
	}
	const content = await fs.readFile(resolved.filepath, 'utf8');
	const source = ts.createSourceFile(resolved.filepath, content, ts.ScriptTarget.Latest, true);
	const exported = source.statements.find(ts.isExportAssignment);
	if (!exported || exported.isExportEquals) throw new Error(`Cannot initialize ${resolved.filepath}: expected a default export.`);
	const expression = exported.expression;
	let nextContent: string;
	if (ts.isObjectLiteralExpression(expression)) {
		const last = expression.properties.at(-1);
		nextContent = content.slice(0, expression.end - 1) + '\n\trunChecksBeforePush: true\n' + content.slice(expression.end - 1);
		if (last && !expression.properties.hasTrailingComma) nextContent = nextContent.slice(0, last.end) + ',' + nextContent.slice(last.end);
	} else {
		const replacement = `{ ...(${expression.getText(source)}), runChecksBeforePush: true }`;
		nextContent = content.slice(0, expression.getStart(source)) + replacement + content.slice(expression.end);
	}
	await fs.writeFile(resolved.filepath, nextContent, 'utf8');
}
