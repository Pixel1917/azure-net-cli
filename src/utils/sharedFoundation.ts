import path from 'node:path';
import { discoverContexts, getContextPath, getApplicationCorePath, getBootstrapPath, SHARED_CONTEXT } from './architecture.js';
import { resolveConfigFile } from './loadConfig.js';

export type FoundationConstruct = 'datasource' | 'presenter' | 'provider' | 'response' | 'schema';
export type ContextConfig = { name: string; alias: string };
export const SHARED_ESSENTIALS_DIR_NAME = 'ApplicationCore';
const constructNames: Record<FoundationConstruct, string> = {
	datasource: 'Http',
	presenter: 'Presenter',
	provider: 'Http',
	response: 'Http',
	schema: 'Validation'
};

export async function getSharedState(): Promise<{ contexts: ContextConfig[]; sharedAlias: string; sharedContext: ContextConfig }> {
	const names = await discoverContexts();
	if (!names.includes(SHARED_CONTEXT)) names.push(SHARED_CONTEXT);
	const contexts = names.sort().map((name) => ({ name, alias: `#contexts/${name}` }));
	return { contexts, sharedAlias: '#applicationCore', sharedContext: contexts.find((context) => context.name === SHARED_CONTEXT)! };
}
export const hasSharedAliasConfig = async (): Promise<boolean> => true;
export const getSharedContextRootPath = (name = SHARED_CONTEXT): string => getContextPath(name);
export const getSharedEssentialsPath = (...compatibility: [name?: string]): string => {
	void compatibility;
	return getApplicationCorePath();
};
export const getFoundationRootPath = (...compatibility: [name?: string]): string => {
	void compatibility;
	return getApplicationCorePath();
};
export const getFoundationConstructPath = (name: string, construct: FoundationConstruct): string =>
	path.join(getFoundationRootPath(name), constructNames[construct]);
export const getFoundationConstructImportPath = (_alias: string, construct: FoundationConstruct): string =>
	`#applicationCore/${constructNames[construct]}`;
export const getLocalizationPath = (...compatibility: [name?: string]): string => {
	void compatibility;
	return path.join(getBootstrapPath(), 'Localization');
};
export const getLocalizationImportPath = (...compatibility: [alias?: string]): string => {
	void compatibility;
	return '#bootstrap/Localization';
};
export const getConfigFileLabel = (): string => {
	const config = resolveConfigFile();
	return config.exists ? path.basename(config.filepath) : 'azure-net.config.ts/js';
};
