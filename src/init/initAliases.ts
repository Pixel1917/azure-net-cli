import { initializePackageImports } from '../utils/packageImports.js';
import { ARCHITECTURE_ALIASES, normalizePascalName } from '../utils/architecture.js';

type ContextConfig = { name: string; alias: string };
/** Compatibility only: architecture discovery never reads configured contexts. */
export function normalizeContexts(raw: unknown): ContextConfig[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		const value = typeof item === 'string' ? item : item?.name;
		if (typeof value !== 'string' || !value.trim()) return [];
		const name = normalizePascalName(value);
		return [{ name, alias: `#contexts/${name}` }];
	});
}
export function generateAliases(): { contexts: ContextConfig[]; aliases: Record<string, string> } {
	return { contexts: [], aliases: { ...ARCHITECTURE_ALIASES } };
}

export { mergeAliasesInSvelteConfig } from '../utils/legacyAliases.js';

export default async function initAliases(): Promise<void> {
	await initializePackageImports();
}
