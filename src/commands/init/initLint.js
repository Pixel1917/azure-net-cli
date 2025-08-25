import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import prompts from 'prompts';

const dependencies = [
    '@commitlint/cli',
    'semantic-release',
    '@semantic-release/git',
    'git-cz',
    'husky',
    'commitizen',
    'env-cmd'
];

const scriptsToAdd = {
    precommit: 'pnpm lint && pnpm check',
    'semantic-release': 'env-cmd semantic-release',
    commit: 'pnpm format && git add . && git-cz && git push',
    release: 'pnpm commit && pnpm semantic-release'
};

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

export default async function initLint() {
    const cwd = process.cwd();
    const pkgPath = path.join(cwd, 'package.json');

    if (!fs.existsSync(pkgPath)) {
        console.error('❌ package.json not found in this directory');
        process.exit(1);
    }

    const { manager } = await prompts({
        type: 'select',
        name: 'manager',
        message: 'Choose your package manager:',
        choices: [
            { title: 'pnpm', value: 'pnpm' },
            { title: 'npm', value: 'npm' },
            { title: 'yarn', value: 'yarn' }
        ],
        initial: 0
    });

    const installCommand =
        manager === 'pnpm'
            ? `pnpm add -D ${dependencies.join(' ')}`
            : manager === 'npm'
                ? `npm install -D ${dependencies.join(' ')}`
                : `yarn add -D ${dependencies.join(' ')}`;

    console.log(`📦 Installing packages with ${manager}...`);
    execSync(installCommand, { stdio: 'inherit' });

    console.log('📁 Updating package.json...');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    pkg.scripts = {
        ...pkg.scripts,
        ...scriptsToAdd
    };

    pkg.config = pkg.config || {};
    pkg.config.commitizen = {
        path: 'git-cz'
    };

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4));

    // Write config files
    fs.writeFileSync(path.join(cwd, 'commitlint.config.ts'), commitlintConfig);
    fs.writeFileSync(path.join(cwd, 'release.config.ts'), releaseConfig);
    fs.writeFileSync(path.join(cwd, '.prettierrc'), prettierConfig);

    console.log('🔧 Initializing Husky...');
    execSync(`${manager === 'npm' ? 'npx' : manager} husky`, { stdio: 'inherit' });
    execSync('npm run format', { stdio: 'inherit' });
    console.log('✅ Linting and release setup completed! Change your prepare script in package.json: node -e \"if (process.env.NODE_ENV !== \'production\'){process.exit(1)} \" || (husky && svelte-kit sync)');
}