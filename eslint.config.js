import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['dist/**', 'node_modules/**']
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['bin/**/*.ts', 'src/plugins/**/*.ts'],
		languageOptions: {
			globals: {
				console: 'readonly',
				process: 'readonly'
			}
		}
	},
	{
		files: [
			'src/generate/module/repositoryModuleShared.ts',
			'src/generate/layers/repositoryShared.ts',
			'src/generate/layers/generateUseCases.ts',
			'src/generate/layers/generateRepositoryMethod.ts',
			'src/generate/layers/generateRepository.ts',
			'src/utils/contextUtils.ts',
			'src/utils/loadConfig.ts',
			'src/utils/fileUtils.ts'
		],
		rules: {
			'@typescript-eslint/ban-ts-comment': 'off'
		}
	}
);
