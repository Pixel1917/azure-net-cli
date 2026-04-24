import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const dependencies = ['@commitlint/cli', 'semantic-release', '@semantic-release/git', 'git-cz', 'husky', 'commitizen', 'env-cmd'];

const commitlintConfig = `export default {
	rules: {
		'body-leading-blank': [2, 'always'],
		'footer-leading-blank': [2, 'always'],
		'header-max-length': [2, 'always', 72],
		'subject-empty': [2, 'never'],
		'subject-full-stop': [2, 'never', '.'],
		'type-case': [2, 'always', 'lower-case'],
		'type-empty': [2, 'never'],
		'type-enum': [2, 'always', ['feat', 'fix', 'refactor', 'perf', 'chore', 'docs', 'style', 'test', 'ci']]
	}
};
`;

const releaseConfig = `export default {
	branches: ['main', 'dev'],
	dryRun: false,
	ci: false,
	plugins: [
		[
			'@semantic-release/commit-analyzer',
			{
				releaseRules: [
					{ type: 'release', release: 'major' },
					{ type: 'feature', release: 'minor' },
					{ type: 'perf', release: false },
					{ type: 'refactor', release: false },
					{ type: 'fix', release: 'patch' },
					{ type: 'chore', release: false },
					{ type: 'ci', release: false },
					{ type: 'docs', scope: 'README', release: false },
					{ type: 'test', release: false },
					{ type: 'style', release: false }
				]
			}
		],
		'@semantic-release/release-notes-generator'
	]
};
`;

const prettierConfig = `{
	"useTabs": true,
	"singleQuote": true,
	"trailingComma": "none",
	"tabWidth": 2,
	"semi": true,
	"printWidth": 150,
	"plugins": ["prettier-plugin-svelte"],
	"overrides": [
		{
			"files": "*.svelte",
			"options": {
				"parser": "svelte"
			}
		}
	]
}
`;

const resolveInstallCommand = (manager) => {
	const deps = dependencies.join(' ');
	switch (manager) {
		case 'pnpm':
			return `pnpm add -D ${deps}`;
		case 'npm':
			return `npm install -D ${deps}`;
		case 'yarn':
			return `yarn add -D ${deps}`;
		case 'bun':
			return `bun add -d ${deps}`;
		default:
			return `pnpm add -D ${deps}`;
	}
};

const resolveRunScriptCommand = (manager, script) => {
	switch (manager) {
		case 'pnpm':
			return `pnpm ${script}`;
		case 'npm':
			return `npm run ${script}`;
		case 'yarn':
			return `yarn ${script}`;
		case 'bun':
			return `bun run ${script}`;
		default:
			return `pnpm ${script}`;
	}
};

const resolveHuskyCommand = (manager) => {
	switch (manager) {
		case 'pnpm':
			return 'pnpm exec husky';
		case 'npm':
			return 'npx husky';
		case 'yarn':
			return 'yarn husky';
		case 'bun':
			return 'bunx husky';
		default:
			return 'pnpm exec husky';
	}
};

const detectPackageManager = (cwd) => {
	if (fs.existsSync(path.join(cwd, 'bun.lock')) || fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
	if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
	if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
	if (fs.existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
	return undefined;
};

const parseConfigState = (cwd) => {
	const tsPath = path.join(cwd, 'azure-net.config.ts');
	const jsPath = path.join(cwd, 'azure-net.config.js');
	const configPath = fs.existsSync(tsPath) ? tsPath : fs.existsSync(jsPath) ? jsPath : null;

	if (!configPath) {
		return {
			configPath: null,
			content: null,
			hasPackageManagerKey: false,
			validPackageManager: null
		};
	}

	const content = fs.readFileSync(configPath, 'utf-8');
	const hasPackageManagerKey = /packageManager\s*:/.test(content);
	const managerMatch = content.match(/packageManager\s*:\s*['"`](bun|pnpm|npm|yarn)['"`]/);
	const validPackageManager = managerMatch?.[1] ?? null;

	return {
		configPath,
		content,
		hasPackageManagerKey,
		validPackageManager
	};
};

const upsertPackageManagerInConfig = (content, manager) => {
	const packageManagerEntry = `packageManager: '${manager}'`;
	const hasExportDefaultObject = /export\s+default\s*\{[\s\S]*\}\s*;?/.test(content);

	if (!hasExportDefaultObject) {
		return `export default {\n\t${packageManagerEntry}\n};\n`;
	}

	if (/packageManager\s*:/.test(content)) {
		return content.replace(/packageManager\s*:\s*['"`][^'"`]+['"`]/, packageManagerEntry);
	}

	return content.replace(/export\s+default\s*\{([\s\S]*?)\}\s*;?/, (_full, body) => {
		const trimmedRight = body.replace(/\s*$/, '');
		if (!trimmedRight.length) {
			return `export default {\n\t${packageManagerEntry}\n};`;
		}

		const withComma = trimmedRight.endsWith(',') ? trimmedRight : `${trimmedRight},`;
		return `export default {${withComma}\n\t${packageManagerEntry}\n};`;
	});
};

const localOnlyPrepareScript = `node -e "const local = !process.env.CI && process.env.NODE_ENV !== 'production' && !process.env.DOCKER && !process.env.CONTAINER; process.exit(local ? 1 : 0)" || (husky && svelte-kit sync)`;

const selectPackageManager = async (cwd, preset) => {
	if (preset) return preset;
	const { default: prompts } = await import('prompts');

	const order = ['bun', 'pnpm', 'npm', 'yarn'];
	const detected = detectPackageManager(cwd);
	const response = await prompts({
		type: 'select',
		name: 'manager',
		message: 'Choose your package manager:',
		choices: order.map((item) => ({ title: item, value: item })),
		initial: detected ? order.indexOf(detected) : 0
	});

	if (!response.manager) {
		throw new Error('Package manager is required');
	}
	return response.manager;
};

export default async function addLint(options = {}) {
	const cwd = process.cwd();
	const pkgPath = path.join(cwd, 'package.json');

	if (!fs.existsSync(pkgPath)) {
		console.error('❌ package.json not found in this directory');
		process.exit(1);
	}

	const configState = parseConfigState(cwd);
	const manager = configState.validPackageManager ?? (await selectPackageManager(cwd, options.manager));

	if (!configState.configPath) {
		const newConfigPath = path.join(cwd, 'azure-net.config.ts');
		fs.writeFileSync(newConfigPath, `export default {\n\tpackageManager: '${manager}'\n};\n`);
	} else if (!configState.validPackageManager || !configState.hasPackageManagerKey) {
		const nextConfig = upsertPackageManagerInConfig(configState.content ?? '', manager);
		fs.writeFileSync(configState.configPath, nextConfig);
	}

	const installCommand = resolveInstallCommand(manager);
	const runFormatCommand = resolveRunScriptCommand(manager, 'format');
	const preCommitScript = `${resolveRunScriptCommand(manager, 'lint')} && ${resolveRunScriptCommand(manager, 'check')}`;
	const commitScript = `${resolveRunScriptCommand(manager, 'format')} && git add . && git-cz && git push`;
	const releaseScript = `${resolveRunScriptCommand(manager, 'commit')} && ${resolveRunScriptCommand(manager, 'semantic-release')}`;

	console.log(`📦 Installing packages with ${manager}...`);
	execSync(installCommand, { stdio: 'inherit' });

	console.log('📁 Updating package.json...');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
	pkg.scripts = {
		...(pkg.scripts || {}),
		precommit: preCommitScript,
		prepare: localOnlyPrepareScript,
		'semantic-release': 'env-cmd semantic-release',
		commit: commitScript,
		release: releaseScript
	};

	pkg.config = pkg.config || {};
	pkg.config.commitizen = {
		path: 'git-cz'
	};

	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4));
	fs.writeFileSync(path.join(cwd, 'commitlint.config.ts'), commitlintConfig);
	fs.writeFileSync(path.join(cwd, 'release.config.ts'), releaseConfig);
	fs.writeFileSync(path.join(cwd, '.prettierrc'), prettierConfig);

	console.log('🔧 Initializing Husky...');
	try {
		execSync(resolveHuskyCommand(manager), { stdio: 'inherit' });
	} catch {
		console.warn('⚠️ Husky initialization skipped (command failed in current environment).');
	}

	try {
		execSync(runFormatCommand, { stdio: 'inherit' });
	} catch {
		console.warn('⚠️ Format script execution skipped (script may be missing).');
	}

	console.log(`✅ Linting and release setup completed! Added prepare script: ${localOnlyPrepareScript}`);
}
