import path from 'node:path';
import { normalizeContexts } from '../init/initAliases.js';
import { loadUserConfig, resolveConfigFile } from './loadConfig.js';

export type FoundationConstruct = 'datasource' | 'presenter' | 'provider' | 'response' | 'schema';
export type ContextConfig = { name: string; alias: string };

export const SHARED_ESSENTIALS_DIR_NAME = 'essentials';

const normalizeAlias = (value: unknown): string => {
	const raw = String(value ?? '').trim();
	return raw.startsWith('$') ? raw : `$${raw}`;
};

const createMissingSharedAliasError = (): Error =>
	new Error(
		'`sharedAlias` is missing in azure-net.config.ts/js. Add sharedAlias and make sure it points to one of `contexts`, for example: sharedAlias: "$shared-kernel".'
	);

export const getSharedState = async (): Promise<{ contexts: ContextConfig[]; sharedAlias: string; sharedContext: ContextConfig }> => {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts) as ContextConfig[];
	const sharedAliasRaw = String(config.sharedAlias ?? '').trim();

	if (!sharedAliasRaw.length) throw createMissingSharedAliasError();

	const sharedAlias = normalizeAlias(sharedAliasRaw);
	const sharedContext = contexts.find((context) => normalizeAlias(context.alias) === sharedAlias);

	if (!sharedContext) {
		throw new Error(
			`sharedAlias "${sharedAlias}" does not point to any configured context. Add a context with alias "${sharedAlias}" in azure-net.config.ts/js.`
		);
	}

	return {
		contexts,
		sharedAlias,
		sharedContext
	};
};

export const hasSharedAliasConfig = async (): Promise<boolean> => {
	const config = await loadUserConfig();
	return String(config.sharedAlias ?? '').trim().length > 0;
};

export const getSharedContextRootPath = (sharedContextName: string): string => path.join(process.cwd(), 'src', 'app', sharedContextName);

export const getSharedEssentialsPath = (sharedContextName: string): string =>
	path.join(getSharedContextRootPath(sharedContextName), SHARED_ESSENTIALS_DIR_NAME);

export const getFoundationRootPath = (sharedContextName: string): string =>
	path.join(getSharedEssentialsPath(sharedContextName), 'foundation', 'constructs');

export const getFoundationConstructPath = (sharedContextName: string, construct: FoundationConstruct): string =>
	path.join(getFoundationRootPath(sharedContextName), construct);

export const getFoundationConstructImportPath = (sharedAlias: string, construct: FoundationConstruct): string =>
	`${sharedAlias}/${SHARED_ESSENTIALS_DIR_NAME}/foundation/constructs/${construct}`;

export const getLocalizationPath = (sharedContextName: string): string =>
	path.join(getSharedEssentialsPath(sharedContextName), 'localization');

export const getLocalizationImportPath = (sharedAlias: string): string => `${sharedAlias}/${SHARED_ESSENTIALS_DIR_NAME}/localization`;

export const getConfigFileLabel = (): string => {
	const config = resolveConfigFile();
	return config.exists ? path.basename(config.filepath) : 'azure-net.config.ts/js';
};
