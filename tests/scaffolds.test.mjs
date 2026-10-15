import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import prompts from 'prompts';

// Exercise current TypeScript sources without building or rewriting other agents' files.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
			const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
			return { url: url.href, shortCircuit: true };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		const result = next(url, context);
		if (!url.endsWith('.ts')) return result;
		return {
			format: 'module',
			source: ts.transpileModule(String(result.source), {
				compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
			}).outputText,
			shortCircuit: true
		};
	}
});
const sourceRoot = new URL('../src/', import.meta.url);
const run = async (file, answers = []) => {
	prompts._injected = [];
	prompts.inject(answers);
	const { default: action } = await import(new URL(file, sourceRoot));
	await action();
};
const exists = async (file) => fs.access(file);
const read = async (file) => fs.readFile(file, 'utf8');
const fixture = async (fn) => {
	const previous = process.cwd();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-scaffolds-'));
	process.chdir(dir);
	try {
		await fn(dir);
	} finally {
		process.chdir(previous);
		await fs.rm(dir, { recursive: true, force: true });
	}
};

test('foundation scaffolds work without config or context prompts', () =>
	fixture(async () => {
		const base = 'src/app/Platform/Foundation';
		await run('scaffolds/createResponse.ts', ['Api', true]);
		await run('scaffolds/createDatasource.ts', ['MockApi', 'ApiResponse']);
		await run('scaffolds/createCoreSchema.ts', ['Schema', 'en', false]);
		await run('scaffolds/createSchemaRule.ts', ['file-size']);
		await exists(`${base}/Schema/CustomRules/FileSize.ts`);
		assert.match(await read(`${base}/Datasource/MockApiDatasource.ts`), /\#platform\/Foundation\/Response/);
		await fs.writeFile(`${base}/Response/ApiResponse.ts`, '// preserved');
		await run('scaffolds/createResponse.ts', ['Api', true]);
		assert.equal(await read(`${base}/Response/ApiResponse.ts`), '// preserved');
	}));

test('locales preserve IDs but normalize directories', () =>
	fixture(async () => {
		await run('scaffolds/createTranslationManager.ts', ['en, pt-BR', 'pt-BR']);
		const root = 'src/app/Platform/Bootstrap/Localization';
		await exists(`${root}/Locales/PtBR/index.ts`);
		assert.match(await read(`${root}/Locales/index.ts`), /'pt-BR':.*\.\/PtBR'/);
		assert.match(await read(`${root}/index.ts`), /initLang: 'pt-BR'/);
		assert.match(await read(`${root}/index.ts`), /@azure-net\/kit\/i18n/);
		assert.match(await read(`${root}/index.ts`), /useTranslations\(TranslationManager\)/);
		assert.match(await read('src/program.ts'), /useTranslations\(TranslationManager\)/);
		assert.doesNotMatch(await read(`${root}/index.ts`), /edges-translations|createStore|writable/);
	}));

test('routes use Bootstrap and resolve cwd per invocation', () =>
	fixture(async () => {
		await fs.mkdir('src/routes/(account)/users/[[id]]', { recursive: true });
		await fs.writeFile('src/routes/(account)/users/[[id]]/+page.svelte', '');
		await run('generate/routes/generateRoutes.ts', ['root-groups']);
		const output = await read('src/app/Platform/Bootstrap/Routes/index.ts');
		assert.match(output, /accountRoutes/);
		assert.match(output, /\/users\/\{id\}/);
		assert.match(output, /'\/users'/);
	}));

test('UI artifacts preserve Svelte props and style API in flat and grouped workspaces', () =>
	fixture(async () => {
		await fs.mkdir('src/app/Presentation/Ui', { recursive: true });
		await run('generate/ui/generateComponent.ts', ['user-card', 'page', 'account-home']);
		const flat = 'src/app/Presentation/Ui/Components/Page/AccountHome/UserCard';
		assert.match(await read(`${flat}/Component.svelte`), /IComponentUserCardProps.*\$props\(\)/s);
		assert.match(await read(`${flat}/Component.svelte`), /@use '.\/Style'/);
		await exists(`${flat}/Types.ts`);
		await exists(`${flat}/Style.scss`);
		await fs.rm('src/app/Presentation', { recursive: true });
		await fs.mkdir('src/app/Presentation/Admin/Ui', { recursive: true });
		await run('generate/ui/generateWidget.ts', ['Admin', 'order-list']);
		await exists('src/app/Presentation/Admin/Ui/Widgets/OrderList/index.ts');
		await run('generate/ui/generateDesignComponent.ts', ['Admin', 'button']);
		await exists('src/app/Presentation/Admin/Ui/Design/Button/Types.ts');
	}));

test('commit tools configure only and preserve existing scripts', () =>
	fixture(async () => {
		await fs.writeFile('package.json', JSON.stringify({ scripts: { commit: 'custom' }, devDependencies: { keep: '1' } }));
		await run('install/configureCommitTools.ts');
		const pkg = JSON.parse(await read('package.json'));
		assert.equal(pkg.scripts.commit, 'custom');
		assert.deepEqual(pkg.devDependencies, { keep: '1' });
		await exists('.prettierrc');
		for (const absent of ['commitlint.config.js', 'release.config.js', '.husky', 'node_modules']) {
			await assert.rejects(fs.access(absent), { code: 'ENOENT' });
		}
		assert.deepEqual((await fs.readdir('.')).sort(), ['.prettierrc', 'package.json']);
	}));

for (const configSource of [
	`export default { groupRoutesFunc: (route) => { return route.rootGroup ?? 'app'; }, nested: { defaultSchemaFactory: 'untouched' } };\nexport const extra = () => ({ keep: true });`,
	`const config = { groupRoutesFunc(route) { return route.rootGroup ?? 'app'; }, defaultSchemaFactory: 'Old', defaultPresenterFactory: 'Old' };\nexport default config;`,
	`const defineConfig = (value) => value;\nexport default defineConfig({ groupRoutesFunc: (route) => route.rootGroup ?? 'app', defaultSchema: { name: 'Legacy' } });`
]) {
	test(`factory config updates preserve functions: ${configSource.slice(0, 35)}`, () =>
		fixture(async () => {
			await fs.writeFile('azure-net.config.ts', configSource);
			await run('scaffolds/createCoreSchema.ts', ['CustomSchema', 'en', true]);
			const { loadUserConfig } = await import(new URL('utils/loadConfig.ts', sourceRoot));
			const config = await loadUserConfig();
			assert.equal(config.defaultSchemaFactory, 'CustomSchema');
			assert.equal(config.groupRoutesFunc({ rootGroup: 'admin' }), 'admin');
			assert.equal(config.groupRoutesFunc({}), 'app');
			if (config.nested) assert.equal(config.nested.defaultSchemaFactory, 'untouched');
		}));
}

test('program filename respects plugin contract and is never overwritten', () =>
	fixture(async () => {
		await run('scaffolds/createProgram.ts');
		assert.match(await read('src/program.ts'), /createApp\(\(app\) => app\)/);
		assert.match(await read('src/program.ts'), /export const \{ register \}/);
		assert.doesNotMatch(await read('src/program.ts'), /Container|\.dependencies\(/);
		await fs.writeFile('src/program.ts', '// custom');
		await run('scaffolds/createProgram.ts');
		assert.equal(await read('src/program.ts'), '// custom');
		assert.deepEqual(await fs.readdir('src'), ['program.ts']);
	}));

let svelteCompiler;
for (const base of [import.meta.url, new URL('../../azure-net-kit/package.json', import.meta.url)]) {
	try {
		svelteCompiler = createRequire(base)('svelte/compiler');
		break;
	} catch {
		/* Optional fixture compiler. */
	}
}
test('generated UI fixtures compile for Svelte client and server', { skip: !svelteCompiler && 'Svelte compiler unavailable' }, () =>
	fixture(async () => {
		await fs.mkdir('src/app/Presentation/Ui', { recursive: true });
		for (const [generator, answers, relative] of [
			['generateComponent', ['Card', 'shared'], 'Components/Shared/Card'],
			['generateWidget', ['Feed'], 'Widgets/Feed'],
			['generateDesignComponent', ['Button'], 'Design/Button']
		]) {
			await run('generate/ui/' + generator + '.ts', answers);
			const filename = path.resolve('src/app/Presentation/Ui', relative, 'Component.svelte');
			for (const generate of ['client', 'server']) {
				const result = svelteCompiler.compile(await read(filename), { filename, generate });
				assert.equal(result.warnings.length, 0);
				assert.ok(result.js.code);
			}
		}
	})
);

test('install fresh initializes without legacy config and keeps program contract', () =>
	fixture(async () => {
		await fs.writeFile('package.json', JSON.stringify({ type: 'module' }));
		await fs.writeFile('vite.config.ts', "import { sveltekit } from '@sveltejs/kit/vite'; export default {plugins: [sveltekit()]};");
		await run('install/installFresh.ts', Array(7).fill(false));
		await exists('src/program.ts');
		await exists('src/app/Platform/Foundation/DI/ApplicationProvider.ts');
		await exists('src/app/Presentation/Ui');
		const config = await read('azure-net.config.ts');
		assert.doesNotMatch(config, /contexts|sharedAlias/);
	}));

test('store generator creates a rune class and singleton accessor in a selected scope', () =>
	fixture(async () => {
		await fs.mkdir('src/app/Presentation/Ui', { recursive: true });
		await fs.mkdir('src/app/Presentation/Scopes/Identity', { recursive: true });
		await run('generate/module/generateStore.ts', ['Identity', 'CurrentUser']);
		const content = await read('src/app/Presentation/Scopes/Identity/CurrentUser.svelte.ts');
		assert.match(content, /export class CurrentUser/);
		assert.match(content, /\$state<string \| null>/);
		assert.match(content, /RegisterProvider\(\(\) => new CurrentUser\(\), 'singleton'\)/);
		assert.match(await read('src/app/Presentation/Scopes/Identity/index.ts'), /CurrentUser\.svelte/);
	}));

test('translation scaffold preserves custom program pipelines', () =>
	fixture(async () => {
		await fs.mkdir('src', { recursive: true });
		const program =
			"import { createApp } from '@azure-net/kit';\nexport const { register } = createApp(app => app.useClient(() => console.log('keep')));\n";
		await fs.writeFile('src/program.ts', program);
		await run('scaffolds/createTranslationManager.ts', ['en, ru', 'en']);
		assert.equal(await read('src/program.ts'), program);
	}));

test('translation scaffold connects an empty program only once', () =>
	fixture(async () => {
		await run('scaffolds/createProgram.ts', []);
		await run('scaffolds/createTranslationManager.ts', ['en, ru', 'en']);
		const program = await read('src/program.ts');
		assert.match(program, /app.useTranslations\(TranslationManager\)/);
		await run('scaffolds/createTranslationManager.ts', ['en, ru', 'en']);
		assert.equal(await read('src/program.ts'), program);
	}));
