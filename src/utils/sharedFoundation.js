import path from 'node:path';
import { discoverContexts, getContextPath, getPlatformPath, SHARED_CONTEXT } from './architecture.js';
import { resolveConfigFile } from './loadConfig.js';
export const SHARED_ESSENTIALS_DIR_NAME = 'Platform';
const constructNames = {
    datasource: 'Datasource',
    presenter: 'Presenter',
    provider: 'DI',
    response: 'Response',
    schema: 'Schema'
};
export async function getSharedState() {
    const names = await discoverContexts();
    if (!names.includes(SHARED_CONTEXT))
        names.push(SHARED_CONTEXT);
    const contexts = names.sort().map((name) => ({ name, alias: `#contexts/${name}` }));
    return { contexts, sharedAlias: '#platform', sharedContext: contexts.find((context) => context.name === SHARED_CONTEXT) };
}
export const hasSharedAliasConfig = async () => true;
export const getSharedContextRootPath = (name = SHARED_CONTEXT) => getContextPath(name);
export const getSharedEssentialsPath = (...compatibility) => {
    void compatibility;
    return getPlatformPath();
};
export const getFoundationRootPath = (...compatibility) => {
    void compatibility;
    return path.join(getPlatformPath(), 'Foundation');
};
export const getFoundationConstructPath = (name, construct) => path.join(getFoundationRootPath(name), constructNames[construct]);
export const getFoundationConstructImportPath = (_alias, construct) => `#platform/Foundation/${constructNames[construct]}`;
export const getLocalizationPath = (...compatibility) => {
    void compatibility;
    return path.join(getPlatformPath(), 'Bootstrap', 'Localization');
};
export const getLocalizationImportPath = (...compatibility) => {
    void compatibility;
    return '#platform/Bootstrap/Localization';
};
export const getConfigFileLabel = () => {
    const config = resolveConfigFile();
    return config.exists ? path.basename(config.filepath) : 'azure-net.config.ts/js';
};
