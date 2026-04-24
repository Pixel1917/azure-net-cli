import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG = {
	contexts: [],
	defaultContext: 'web',
	coreAlias: '$core'
};

function toObjectFromDefaultExport(content) {
	const source = String(content ?? '').trim();
	if (!source.length) return {};

	const replacedExport = source.replace(/^\s*export\s+default\s+/m, 'return ');
	if (replacedExport === source) return {};

	const withSemicolon = /;\s*$/.test(replacedExport) ? replacedExport : `${replacedExport};`;

	try {
		// eslint-disable-next-line no-new-func
		return new Function(withSemicolon)() ?? {};
	} catch {
		return {};
	}
}

export function resolveConfigFile(cwd = process.cwd()) {
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

export async function loadUserConfig() {
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

		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
