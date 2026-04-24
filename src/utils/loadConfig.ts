import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export type AzureNetConfig = {
	contexts: Array<string | { name?: string; alias?: string }>;
	defaultContext: string;
	coreAlias: string;
	sharedAlias?: string;
	packageManager?: string;
	defaultSchemaFactory?: string;
	defaultPresenterFactory?: string;
	[key: string]: unknown;
};

const DEFAULT_CONFIG: AzureNetConfig = {
	contexts: [],
	defaultContext: 'web',
	coreAlias: '$core'
};

function toObjectFromDefaultExport(content: string): Record<string, unknown> {
	const source = String(content ?? '').trim();
	if (!source.length) return {};

	const replacedExport = source.replace(/^\s*export\s+default\s+/m, 'return ');
	if (replacedExport === source) return {};

	const withSemicolon = /;\s*$/.test(replacedExport) ? replacedExport : `${replacedExport};`;

	try {
		return new Function(withSemicolon)() ?? {};
	} catch {
		return {};
	}
}

export function resolveConfigFile(cwd = process.cwd()): { exists: boolean; filepath: string; type: 'ts' | 'js' } {
	const tsPath = path.join(cwd, 'azure-net.config.ts');
	const jsPath = path.join(cwd, 'azure-net.config.js');

	if (fsSync.existsSync(tsPath)) {
		return { exists: true, filepath: tsPath, type: 'ts' };
	}
	if (fsSync.existsSync(jsPath)) {
		return { exists: true, filepath: jsPath, type: 'js' };
	}

	return { exists: false, filepath: tsPath, type: 'ts' };
}

export async function loadUserConfig(): Promise<AzureNetConfig> {
	const { exists, filepath } = resolveConfigFile();
	if (!exists) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const content = await fs.readFile(filepath, 'utf-8');
		const parsed = toObjectFromDefaultExport(content);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return { ...DEFAULT_CONFIG };
		}

		return { ...DEFAULT_CONFIG, ...(parsed as Record<string, unknown>) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
