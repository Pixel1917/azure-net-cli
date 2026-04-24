import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const EDGES_IMPORT = `import { edgesPlugin } from '@azure-net/kit/edges/plugin';`;

function resolveViteConfigPath() {
	const cwd = process.cwd();
	const candidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'].map((filename) => path.join(cwd, filename));

	for (const filepath of candidates) {
		if (fsSync.existsSync(filepath)) {
			return filepath;
		}
	}

	return null;
}

function injectEdgesImport(content) {
	if (content.includes(EDGES_IMPORT)) return content;

	const svelteImportRegex = /import\s+\{\s*sveltekit\s*\}\s+from\s+['"]@sveltejs\/kit\/vite['"]\s*;?/m;
	if (svelteImportRegex.test(content)) {
		return content.replace(svelteImportRegex, (line) => `${line}\n${EDGES_IMPORT}`);
	}

	return `${EDGES_IMPORT}\n${content}`;
}

function injectEdgesPlugin(content) {
	if (/edgesPlugin\s*\(\s*\)/.test(content)) return content;

	const pluginsRegex = /plugins\s*:\s*\[([\s\S]*?)\]/m;
	const pluginsMatch = content.match(pluginsRegex);
	if (!pluginsMatch) {
		throw new Error('plugins array was not found in vite.config');
	}

	const pluginsBody = pluginsMatch[1] ?? '';
	let nextPluginsBody = pluginsBody;

	if (/sveltekit\s*\(\s*\)/.test(pluginsBody)) {
		nextPluginsBody = pluginsBody.replace(/sveltekit\s*\(\s*\)\s*,?/, (matched) => {
			const hasComma = matched.trim().endsWith(',');
			return hasComma ? `${matched} edgesPlugin(),` : `${matched}, edgesPlugin()`;
		});
	} else {
		const trimmed = pluginsBody.trim();
		if (!trimmed.length) {
			nextPluginsBody = 'edgesPlugin()';
		} else {
			const withComma = /\s*,\s*$/.test(pluginsBody) ? pluginsBody : `${pluginsBody},`;
			nextPluginsBody = `${withComma} edgesPlugin()`;
		}
	}

	return content.replace(pluginsRegex, `plugins: [${nextPluginsBody}]`);
}

export default async function initEdges() {
	const viteConfigPath = resolveViteConfigPath();
	if (!viteConfigPath) {
		console.error('❌ vite.config.(ts|js|mjs|cjs) was not found');
		return;
	}

	let content = await fs.readFile(viteConfigPath, 'utf-8');
	content = injectEdgesImport(content);
	content = injectEdgesPlugin(content);
	await fs.writeFile(viteConfigPath, content, 'utf-8');

	console.log(`✅ Edges plugin initialized in ${path.basename(viteConfigPath)}`);
}
