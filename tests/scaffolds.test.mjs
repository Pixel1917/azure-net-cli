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

test('application core scaffolds work without config or context prompts', () =>
	fixture(async () => {
		const base = 'src/app/ApplicationCore';
		await run('scaffolds/createResponse.ts', ['ApiDatasource', 'Api', true]);
		await run('scaffolds/createDatasource.ts', ['__new__', 'MockApi', true, 'Api', true, 'ApiResponse', true]);
		await run('scaffolds/createCoreSchema.ts', ['Schema', 'en', false]);
		await run('scaffolds/createSchemaRule.ts', ['file-size']);
		await exists(`${base}/Validation/CustomRules/FileSize.ts`);
		assert.match(await read(`${base}/Http/MockApiDatasource/Datasource.ts`), /from '\.\/ApiResponse'/);
		await fs.writeFile(`${base}/Http/ApiDatasource/ApiResponse.ts`, '// preserved');
		await run('scaffolds/createResponse.ts', ['ApiDatasource', 'Api', true]);
		assert.equal(await read(`${base}/Http/ApiDatasource/ApiResponse.ts`), '// preserved');
	}));

for (const response of [false, true]) {
	test(`fresh datasource creates its optional response inline (response=${response})`, () =>
		fixture(async () => {
			await fs.writeFile('package.json', JSON.stringify({ type: 'module' }));
			await fs.writeFile('vite.config.ts', "import { sveltekit } from '@sveltejs/kit/vite'; export default {plugins: [sveltekit()]};");
			await run('install/installFresh.ts', [
				false,
				true,
				'Backend',
				response,
				...(response ? ['Envelope', true, 'EnvelopeResponse'] : []),
				true,
				false,
				false,
				false,
				false,
				false
			]);
			assert.deepEqual(prompts._injected, []);
			const root = 'src/app/ApplicationCore/Http/BackendDatasource';
			const datasource = await read(`${root}/Datasource.ts`);
			if (response) {
				assert.match(await read(`${root}/EnvelopeResponse.ts`), /interface IEnvelopeResponse<TData, TMeta = unknown>/);
				assert.match(datasource, /from '\.\/EnvelopeResponse'/);
			} else {
				await assert.rejects(fs.access(`${root}/EnvelopeResponse.ts`), { code: 'ENOENT' });
				assert.match(datasource, /Promise<IHttpServiceResponse<TData>>/);
			}
			assert.match(await read(`${root}/HttpProvider.ts`), /CreateServiceContainer\('BackendDatasourceHttpProvider'/);
			await exists('src/bootstrap/index.ts');
			await exists('src/program.ts');
		}));
}

test('locales preserve IDs but normalize directories', () =>
	fixture(async () => {
		await run('scaffolds/createTranslationManager.ts', ['en, pt-BR', 'pt-BR']);
		const root = 'src/bootstrap/Localization';
		await exists(`${root}/Locales/PtBR/index.ts`);
		assert.match(await read(`${root}/Locales/index.ts`), /'pt-BR':.*\.\/PtBR'/);
		assert.match(await read(`${root}/TranslationManager.ts`), /initLang: 'pt-BR'/);
		assert.match(await read(`${root}/TranslationManager.ts`), /TranslationManager as KitTranslationManager/);
		assert.match(await read(`${root}/TranslationManager.ts`), /new KitTranslationManager\(/);
		assert.match(await read(`${root}/index.ts`), /export \* from ["']\.\/TranslationManager["']/);
		assert.equal(await read(`${root}/Locales/PtBR/index.ts`), 'export default {};\n');
		assert.match(await read(`${root}/TranslationManager.ts`), /useTranslations\(TranslationManager\)/);
		await assert.rejects(fs.access('src/program.ts'), { code: 'ENOENT' });
		assert.doesNotMatch(await read(`${root}/TranslationManager.ts`), /createTranslations|edges-translations|createStore|writable/);
	}));

test('routes use Bootstrap and resolve cwd per invocation', () =>
	fixture(async () => {
		await fs.mkdir('src/routes/(account)/users/[[id]]', { recursive: true });
		await fs.writeFile('src/routes/(account)/users/[[id]]/+page.svelte', '');
		await run('generate/routes/generateRoutes.ts', ['root-groups']);
		const output = await read('src/bootstrap/Routes/index.ts');
		assert.match(output, /accountRoutes/);
		assert.match(output, /\/users\/\{id\}/);
		assert.match(output, /'\/users'/);
	}));

test('UI artifacts preserve Svelte props and style API in flat and grouped workspaces', () =>
	fixture(async () => {
		await fs.mkdir('src/app/Presentation/Ui', { recursive: true });
		await run('generate/ui/generateComponent.ts', ['page', 'account-home/user-card']);
		const flat = 'src/app/Presentation/Ui/Components/Page/AccountHome/UserCard';
		assert.match(await read(`${flat}/Component.svelte`), /IUserCardProps.*\$props\(\)/s);
		assert.match(await read(`${flat}/Component.svelte`), /Style.module.scss/);
		await exists(`${flat}/Types.ts`);
		await exists(`${flat}/Style.module.scss`);
		await fs.rm('src/app/Presentation', { recursive: true });
		await fs.mkdir('src/app/Presentation/Admin/Ui', { recursive: true });
		await run('generate/ui/generateComponent.ts', ['Admin', 'composition', 'order-list']);
		await exists('src/app/Presentation/Admin/Ui/Components/Composite/OrderList/index.ts');
		await run('generate/ui/generateComponent.ts', ['Admin', 'core', 'button']);
		await exists('src/app/Presentation/Admin/Ui/Components/Core/Button/Types.ts');
	}));

test('prettier config writes only and preserve existing scripts', () =>
	fixture(async () => {
		await fs.writeFile('package.json', JSON.stringify({ scripts: { commit: 'custom' }, devDependencies: { keep: '1' } }));
		await run('plugins/prettierConfig.ts');
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
		assert.match(await read('src/program.ts'), /AppBootstrap\(\)/);
		assert.match(await read('src/bootstrap/index.ts'), /createApp\(\(app\) => \{/);
		assert.match(await read('src/program.ts'), /export const \{ register \}/);
		assert.doesNotMatch(await read('src/program.ts'), /Container|\.dependencies\(/);
		await fs.writeFile('src/program.ts', '// custom');
		await run('scaffolds/createProgram.ts');
		assert.equal(await read('src/program.ts'), '// custom');
		assert.deepEqual(await fs.readdir('src'), ['bootstrap', 'program.ts']);
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
			['generateComponent', ['core', 'Card'], 'Components/Core/Card'],
			['generateComponent', ['composition', 'Feed'], 'Components/Composite/Feed'],
			['generateComponent', ['page', 'Button'], 'Components/Page/Button']
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
		await exists('src/bootstrap/index.ts');
		await exists('src/app/Presentation/Public/Ui');
		const config = await read('azure-net.config.ts');
		assert.doesNotMatch(config, /contexts|sharedAlias/);
	}));

test('store generator creates a rune class and singleton accessor in a selected scope', () =>
	fixture(async () => {
		await fs.mkdir('src/app/Presentation/Ui', { recursive: true });
		await fs.mkdir('src/app/Presentation/Scopes/Identity', { recursive: true });
		await run('generate/module/generateStore.ts', ['Identity', 'CurrentUser']);
		const content = await read('src/app/Presentation/Scopes/Identity/Stores/CurrentUser.svelte.ts');
		assert.match(content, /export class CurrentUser/);
		assert.match(content, /\$state<string \| null>/);
		assert.match(await read('src/app/Presentation/Scopes/Identity/Stores/index.ts'), /lifecycle: 'singleton'/);
		assert.match(await read('src/app/Presentation/Scopes/Identity/Stores/index.ts'), /CurrentUser\.svelte/);
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

test('translation scaffold preserves generated bootstrap and program', () =>
	fixture(async () => {
		await run('scaffolds/createProgram.ts', []);
		await run('scaffolds/createTranslationManager.ts', ['en, ru', 'en']);
		const program = await read('src/program.ts');
		assert.match(program, /AppBootstrap\(\)/);
		assert.match(await read('src/bootstrap/index.ts'), /createApp\(\(app\) => \{/);
		await run('scaffolds/createTranslationManager.ts', ['en, ru', 'en']);
		assert.equal(await read('src/program.ts'), program);
	}));

test('application core datasource interfaces and optional provider match response metadata contracts', () =>
	fixture(async () => {
		await run('scaffolds/createResponse.ts', ['ApiDatasource', 'Api', true]);
		await run('scaffolds/createDatasource.ts', ['ApiDatasource', 'ApiResponse', true]);
		const base = 'src/app/ApplicationCore';
		assert.match(await read(`${base}/Http/ApiDatasource/ApiResponse.ts`), /interface IApiResponse<TData, TMeta = unknown>/);
		assert.match(await read(`${base}/Http/ApiDatasource/Datasource.ts`), /implements IApiDatasource/);
		assert.match(await read(`${base}/Http/ApiDatasource/Datasource.ts`), /CreateRequestCallbackType<IApiResponse<TData, TMeta>>/);
		const provider = await read(`${base}/Http/ApiDatasource/HttpProvider.ts`);
		assert.match(provider, /CreateServiceContainer/);
		assert.match(provider, /prefixUrl: ''/);
		await run('scaffolds/createDatasource.ts', ['__new__', 'Other', true, 'Api', true, 'ApiResponse', true]);
		assert.equal(await read(`${base}/Http/ApiDatasource/HttpProvider.ts`), provider);
		await run('scaffolds/createCookieInstance.ts');
		assert.match(await read(`${base}/Cookies/Instance.ts`), /UniversalCookie.createInstance/);
	}));

test('middleware and error handler scaffolds use kit types and preserve Bootstrap', () =>
	fixture(async () => {
		await run('scaffolds/createProgram.ts');
		const bootstrap = 'src/bootstrap/index.ts';
		await fs.writeFile(bootstrap, '// custom bootstrap');
		const logs = [];
		const originalLog = console.log;
		console.log = (...values) => logs.push(values.join(' '));
		try {
			await run('scaffolds/createMiddleware.ts', ['Auth']);
			await run('scaffolds/createErrorHandler.ts');
		} finally {
			console.log = originalLog;
		}
		const guidance = logs.join('\n');
		assert.match(guidance, /new ClientMiddlewareManager/);
		assert.match(guidance, /new ServerMiddlewareManager/);
		assert.match(guidance, /useServerError\(ErrorHandler\)/);
		assert.doesNotMatch(guidance, /useMiddlewares|useAzureNetKitError/);
		for (const side of ['Client', 'Server']) {
			const content = await read(`src/bootstrap/Pipelines/Middlewares/Auth/${side}.ts`);
			assert.match(content, new RegExp(`implements I${side}Middleware`));
			assert.match(content, /return next\(\)/);
		}
		assert.match(await read('src/bootstrap/Handlers/ErrorHandler.ts'), /AppServerErrorContext/);
		assert.match(await read('src/bootstrap/Handlers/ErrorHandler.ts'), /void error/);
		assert.equal(await read(bootstrap), '// custom bootstrap');
	}));

test('generated application core and bootstrap types compile against actual kit declarations', () =>
	fixture(async (dir) => {
		await run('scaffolds/createResponse.ts', ['ApiDatasource', 'Api', true]);
		await run('scaffolds/createResponse.ts', ['__new__', 'Plain', 'Plain', false]);
		await run('scaffolds/createDatasource.ts', ['ApiDatasource', 'ApiResponse', true]);
		await run('scaffolds/createDatasource.ts', ['PlainDatasource', 'PlainResponse', false]);
		await run('scaffolds/createDatasource.ts', ['__new__', 'Raw', false, false]);
		await run('scaffolds/createCookieInstance.ts');
		await run('scaffolds/createMiddleware.ts', ['Auth']);
		await run('scaffolds/createErrorHandler.ts');
		await run('scaffolds/createCoreSchema.ts', ['Schema', 'en', true]);
		const { default: createProgram } = await import(new URL('scaffolds/createProgram.ts', sourceRoot));
		await createProgram({ translations: true, errorHandler: true });
		await run('scaffolds/createTranslationManager.ts', ['en, ru', 'en']);
		await fs.writeFile(
			'src/bootstrap/TypecheckWiring.ts',
			`import { createApp, ClientMiddlewareManager, ServerMiddlewareManager } from '@azure-net/kit';
import { ErrorHandler } from './Handlers';
import { TranslationManager } from './Localization';
import { ClientAuthMiddleware, ServerAuthMiddleware } from './Pipelines/Middlewares';
export const AppBootstrap = () => createApp(app => {
 app.useServerError(ErrorHandler);
 app.useTranslations(TranslationManager);
 app.useClient(() => { new ClientMiddlewareManager([ClientAuthMiddleware]).execute(); });
 app.useServer(async ({ event, resolve }) => { await new ServerMiddlewareManager([ServerAuthMiddleware]).execute(); return resolve(event); });
});
`
		);
		const kit = new URL('../../azure-net-kit/dist/', import.meta.url).pathname;
		const roots = [
			'bootstrap/index.ts',
			'bootstrap/TypecheckWiring.ts',
			'program.ts',
			'app/ApplicationCore/Http/ApiDatasource/Datasource.ts',
			'app/ApplicationCore/Http/PlainDatasource/Datasource.ts',
			'app/ApplicationCore/Http/RawDatasource/Datasource.ts',
			'app/ApplicationCore/Http/ApiDatasource/HttpProvider.ts',
			'app/ApplicationCore/Cookies/Instance.ts',
			'app/ApplicationCore/Validation/Schema.ts',
			'bootstrap/Handlers/ErrorHandler.ts',
			'bootstrap/Pipelines/Middlewares/Auth/Client.ts',
			'bootstrap/Pipelines/Middlewares/Auth/Server.ts'
		].map((file) => path.join(dir, 'src', file));
		const program = ts.createProgram(roots, {
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			baseUrl: dir,
			paths: {
				'#applicationCore/*': ['src/app/ApplicationCore/*'],
				'#bootstrap/*': ['src/bootstrap/*'],
				'#bootstrap': ['src/bootstrap/index.ts'],
				'@azure-net/kit': [path.join(kit, 'index.d.ts')],
				'@azure-net/kit/*': [path.join(kit, '*.d.ts'), path.join(kit, '*/index.d.ts')]
			}
		});
		const errors = ts.getPreEmitDiagnostics(program);
		assert.equal(
			errors.length,
			0,
			ts.formatDiagnosticsWithColorAndContext(errors, {
				getCurrentDirectory: () => dir,
				getCanonicalFileName: (f) => f,
				getNewLine: () => '\n'
			})
		);
	}));

for (const [packageManager, lockfile, expected] of [
	['pnpm@9.0.0', null, 'pnpm'],
	[null, 'yarn.lock', 'yarn'],
	[null, null, 'npm']
]) {
	test(`fresh package manager detects ${expected} without installing packages`, () =>
		fixture(async () => {
			await fs.writeFile('package.json', JSON.stringify({ packageManager }));
			if (lockfile) await fs.writeFile(lockfile, '');
			await run('install/configurePackageManager.ts');
			const { loadUserConfig } = await import(new URL('utils/loadConfig.ts', sourceRoot));
			assert.equal((await loadUserConfig()).packageManager, expected);
			await fs.writeFile('azure-net.config.ts', "export default { packageManager: 'bun', custom: true };");
			await run('install/configurePackageManager.ts');
			assert.equal(await read('azure-net.config.ts'), "export default { packageManager: 'bun', custom: true };");
			await assert.rejects(fs.access('node_modules'), { code: 'ENOENT' });
		}));
}

for (const existing of [false, true]) {
	test(`fresh wires chosen bootstrap features only for a newly created Bootstrap (existing=${existing})`, () =>
		fixture(async () => {
			await fs.writeFile('package.json', JSON.stringify({ type: 'module' }));
			await fs.writeFile('vite.config.ts', "import { sveltekit } from '@sveltejs/kit/vite'; export default {plugins: [sveltekit()]};");
			const bootstrap = 'src/bootstrap/index.ts';
			if (existing) {
				await fs.mkdir(path.dirname(bootstrap), { recursive: true });
				await fs.writeFile(bootstrap, '// existing bootstrap: preserve exactly\n');
			}
			await run('install/installFresh.ts', [false, false, false, true, true, 'en, ru', 'en', false, false]);
			const source = await read(bootstrap);
			if (existing) assert.equal(source, '// existing bootstrap: preserve exactly\n');
			else {
				assert.match(source, /useTranslations\(TranslationManager\)/);
				assert.match(source, /useServerError\(ErrorHandler\)/);
				assert.match(source, /import \{ TranslationManager \} from '#bootstrap\/Localization'/);
				assert.match(source, /import \{ ErrorHandler \} from '#bootstrap\/Handlers'/);
			}
			assert.match(await read('src/program.ts'), /AppBootstrap\(\)/);
			const manager = await read('src/bootstrap/Localization/TranslationManager.ts');
			assert.match(manager, /new KitTranslationManager\(/);
			assert.doesNotMatch(manager, /createTranslations/);
			assert.equal(await read('src/bootstrap/Localization/Locales/En/index.ts'), 'export default {};\n');
		}));
}

test('fresh prints actionable follow-up instructions without modifying an existing layout', () =>
	fixture(async () => {
		await fs.writeFile('package.json', JSON.stringify({ type: 'module' }));
		await fs.writeFile('vite.config.ts', "import { sveltekit } from '@sveltejs/kit/vite'; export default {plugins: [sveltekit()]};");
		await fs.mkdir('src/routes', { recursive: true });
		const layout = '<!-- user-owned layout: preserve byte-for-byte -->\n';
		await fs.writeFile('src/routes/+layout.svelte', layout);
		const logs = [];
		const originalLog = console.log;
		console.log = (...values) => logs.push(values.join(' '));
		try {
			await run('install/installFresh.ts', Array(8).fill(false));
		} finally {
			console.log = originalLog;
		}
		const output = logs.join('\n');
		assert.match(output, /src\/routes\/\+layout.svelte/);
		assert.match(output, /import \{ register \} from '#program';/);
		assert.match(output, /register\(\);/);
		assert.match(output, /synchronously during layout initialization/);
		assert.match(output, /Do not put it inside onMount, an effect, or a module script/);
		assert.match(output, /httpOptions.prefixUrl.*src\/app\/ApplicationCore\/Http\/<DatasourceName>\/HttpProvider.ts/);
		assert.match(output, /fill the empty dictionaries.*bootstrap\/Localization\/Locales/);
		assert.match(output, /azure-net check project/);
		assert.equal(await read('src/routes/+layout.svelte'), layout);
	}));

for (const errorHandler of [false, true]) {
	for (const translations of [false, true]) {
		test(`bootstrap uses void statements: errors=${errorHandler}, translations=${translations}`, () =>
			fixture(async () => {
				const { default: createBootstrap } = await import(new URL('scaffolds/createBootstrap.ts', sourceRoot));
				await createBootstrap({ errorHandler, translations });
				const content = await read('src/bootstrap/index.ts');
				assert.match(content, /createApp\(\(app\) => \{/);
				assert.equal(content.includes('app.useServerError(ErrorHandler);'), errorHandler);
				assert.equal(content.includes('app.useTranslations(TranslationManager);'), translations);
				assert.equal(content.includes("from '#bootstrap/Handlers'"), errorHandler);
				assert.equal(content.includes("from '#bootstrap/Localization'"), translations);
				assert.doesNotMatch(content, /return app|\)\.use/);
			}));
	}
}
