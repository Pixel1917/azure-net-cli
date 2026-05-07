import path from 'node:path';
import { normalizeContexts } from '../init/initAliases.js';
import { loadUserConfig, resolveConfigFile } from './loadConfig.js';
export const SHARED_ESSENTIALS_DIR_NAME = 'essentials';
const normalizeAlias = (value) => {
	const raw = String(value ?? '').trim();
	return raw.startsWith('$') ? raw : `$${raw}`;
};
const createMissingSharedAliasError = () =>
	new Error(
		'`sharedAlias` is missing in azure-net.config.ts/js. Add sharedAlias and make sure it points to one of `contexts`, for example: sharedAlias: "$shared-kernel".'
	);
export const getSharedState = async () => {
	const config = await loadUserConfig();
	const contexts = normalizeContexts(config.contexts);
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
export const hasSharedAliasConfig = async () => {
	const config = await loadUserConfig();
	return String(config.sharedAlias ?? '').trim().length > 0;
};
export const getSharedContextRootPath = (sharedContextName) => path.join(process.cwd(), 'src', 'app', sharedContextName);
export const getSharedEssentialsPath = (sharedContextName) =>
	path.join(getSharedContextRootPath(sharedContextName), SHARED_ESSENTIALS_DIR_NAME);
export const getFoundationRootPath = (sharedContextName) =>
	path.join(getSharedEssentialsPath(sharedContextName), 'foundation', 'constructs');
export const getFoundationConstructPath = (sharedContextName, construct) => path.join(getFoundationRootPath(sharedContextName), construct);
export const getFoundationConstructImportPath = (sharedAlias, construct) =>
	`${sharedAlias}/${SHARED_ESSENTIALS_DIR_NAME}/foundation/constructs/${construct}`;
export const getLocalizationPath = (sharedContextName) => path.join(getSharedEssentialsPath(sharedContextName), 'localization');
export const getLocalizationImportPath = (sharedAlias) => `${sharedAlias}/${SHARED_ESSENTIALS_DIR_NAME}/localization`;
export const getConfigFileLabel = () => {
	const config = resolveConfigFile();
	return config.exists ? path.basename(config.filepath) : 'azure-net.config.ts/js';
};
