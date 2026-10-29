import path from 'node:path';
import { providerDeclarations, report, type Issue } from './architecture.js';

export default async function checkProviderNames(): Promise<void> {
	const issues: Issue[] = [];
	try {
		const providers = await providerDeclarations();
		const named = new Map<string, (typeof providers)[number]>();
		for (const provider of providers) {
			// CompositionRoot uses its own symbol identity; no UUID/name is required.
			if (provider.explicitName === undefined) continue;
			const first = named.get(provider.explicitName);
			if (first)
				issues.push({
					file: provider.file,
					line: provider.line,
					message: `Duplicate provider name "${provider.explicitName}" (first declared at ${path.relative(process.cwd(), first.file)}:${first.line})`
				});
			else named.set(provider.explicitName, provider);
		}
		console.log(`Discovered ${providers.length} service containers/composition roots (${named.size} explicit names).`);
	} catch (error) {
		issues.push({ file: path.join(process.cwd(), 'src'), line: 1, message: String(error) });
	}
	report('Provider names', issues);
}
