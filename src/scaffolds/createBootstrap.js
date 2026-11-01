import path from 'node:path';
import { getBootstrapPath } from '../utils/architecture.js';
import { writeIfNotExists } from '../utils/fileUtils.js';
export default async function createBootstrap(options = {}) {
	const imports = [
		"import { createApp } from '@azure-net/kit';",
		...(options.errorHandler ? ["import { ErrorHandler } from '#bootstrap/Handlers';"] : []),
		...(options.translations ? ["import { TranslationManager } from '#bootstrap/Localization';"] : [])
	];
	const statements = [
		...(options.errorHandler ? ['app.useServerError(ErrorHandler);'] : []),
		...(options.translations ? ['app.useTranslations(TranslationManager);'] : [])
	];
	await writeIfNotExists(
		path.join(getBootstrapPath(), 'index.ts'),
		`${imports.join('\n')}

export const AppBootstrap = () => createApp((app) => {
${statements.map((statement) => `\t${statement}`).join('\n')}
});
`
	);
}
