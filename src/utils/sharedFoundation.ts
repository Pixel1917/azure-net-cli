import path from 'node:path';
import { discoverContexts, getContextPath, getPlatformPath, SHARED_CONTEXT } from './architecture.js';
import { resolveConfigFile } from './loadConfig.js';

export type FoundationConstruct = 'datasource' | 'presenter' | 'provider' | 'response' | 'schema';
export type ContextConfig = { name: string; alias: string };
export const SHARED_ESSENTIALS_DIR_NAME = 'Platform';
const constructNames: Record<FoundationConstruct, string> = {
	datasource: 'Datasource',
	presenter: 'Presenter',
	provider: 'DI',
	response: 'Response',
	schema: 'Schema'
};

export async function getSharedState(): Promise<{ contexts: ContextConfig[]; sharedAlias: string; sharedContext: ContextConfig }> {
	const names = await discoverContexts();
	if (!names.includes(SHARED_CONTEXT)) names.push(SHARED_CONTEXT);
	const contexts = names.sort().map((name) => ({ name, alias: `#contexts/${name}` }));
	return { contexts, sharedAlias: '#platform', sharedContext: contexts.find((context) => context.name === SHARED_CONTEXT)! };
}
export const hasSharedAliasConfig = async (): Promise<boolean> => true;
export const getSharedContextRootPath = (name = SHARED_CONTEXT): string => getContextPath(name);
export const getSharedEssentialsPath = (...compatibility: [name?: string]): string => {
	void compatibility;
	return getPlatformPath();
};
export const getFoundationRootPath = (...compatibility: [name?: string]): string => {
	void compatibility;
	return path.join(getPlatformPath(), 'Foundation');
};
export const getFoundationConstructPath = (name: string, construct: FoundationConstruct): string =>
	path.join(getFoundationRootPath(name), constructNames[construct]);
export const getFoundationConstructImportPath = (_alias: string, construct: FoundationConstruct): string =>
	`#platform/Foundation/${constructNames[construct]}`;
export const getLocalizationPath = (...compatibility: [name?: string]): string => {
	void compatibility;
	return path.join(getPlatformPath(), 'Bootstrap', 'Localization');
};
export const getLocalizationImportPath = (...compatibility: [alias?: string]): string => {
	void compatibility;
	return '#platform/Bootstrap/Localization';
};
export const getConfigFileLabel = (): string => {
	const config = resolveConfigFile();
	return config.exists ? path.basename(config.filepath) : 'azure-net.config.ts/js';
};
