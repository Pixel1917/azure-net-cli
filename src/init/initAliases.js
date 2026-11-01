import { initializePackageImports } from '../utils/packageImports.js';
import { ARCHITECTURE_ALIASES, normalizePascalName } from '../utils/architecture.js';
/** Compatibility only: architecture discovery never reads configured contexts. */
export function normalizeContexts(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.flatMap((item) => {
        const value = typeof item === 'string' ? item : item?.name;
        if (typeof value !== 'string' || !value.trim())
            return [];
        const name = normalizePascalName(value);
        return [{ name, alias: `#contexts/${name}` }];
    });
}
export function generateAliases() {
    return { contexts: [], aliases: { ...ARCHITECTURE_ALIASES } };
}
export { mergeAliasesInSvelteConfig } from '../utils/legacyAliases.js';
export default async function initAliases() {
    await initializePackageImports();
}
