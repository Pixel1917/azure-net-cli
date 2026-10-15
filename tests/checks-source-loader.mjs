// Resolve checks to their TypeScript sources so focused tests never need a build.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		if (resolved.url.startsWith('file:') && resolved.url.includes('/src/checks/') && resolved.url.endsWith('.js')) {
			const source = resolved.url.replace(/\.js$/, '.ts');
			if (existsSync(fileURLToPath(source))) return { ...resolved, url: source };
		}
		return resolved;
	},
	load(url, context, nextLoad) {
		if (url.startsWith('file:') && url.includes('/src/checks/') && url.endsWith('.ts'))
			return {
				format: 'module',
				shortCircuit: true,
				source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' })
			};
		return nextLoad(url, context);
	}
});
