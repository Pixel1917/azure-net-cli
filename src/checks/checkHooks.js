import fs from 'node:fs';
import path from 'node:path';
const forbiddenHooks = ['hooks.server.ts', 'hooks.server.js', 'hooks.client.ts', 'hooks.client.js'];
export default async function checkHooks() {
	const srcPath = path.join(process.cwd(), 'src');
	const found = forbiddenHooks.map((filename) => path.join(srcPath, filename)).filter((filepath) => fs.existsSync(filepath));
	if (!found.length) {
		console.log('✅ No manual SvelteKit hooks found.');
		return;
	}
	console.error('❌ Manual SvelteKit hooks are not allowed with @azure-net/kit AzureNetPlugin.');
	console.error('Move lifecycle code to src/program.ts through createApp(). Found:');
	for (const filepath of found) {
		console.error(` - ${path.relative(process.cwd(), filepath)}`);
	}
	process.exitCode = 1;
}
