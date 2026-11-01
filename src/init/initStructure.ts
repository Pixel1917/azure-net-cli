import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeConfigDefaults, loadUserConfig } from '../utils/loadConfig.js';
import {
	discoverPresentationWorkspaces,
	ensureContextStructure,
	ensurePresentationStructure,
	getApplicationCorePath,
	getBootstrapPath,
	normalizePascalName,
	SHARED_CONTEXT,
	SHARED_WORKSPACE
} from '../utils/architecture.js';
import initAliases from './initAliases.js';

/** Add missing directories without replacing files or removing existing boundaries. */
export default async function initStructure(): Promise<void> {
	await initializeConfigDefaults();
	const config = await loadUserConfig();
	await ensureContextStructure(SHARED_CONTEXT);
	const boundaries = new Set([
		SHARED_WORKSPACE,
		...(config.appBoundaries ?? config.presentationWorkspaces ?? []).map(normalizePascalName),
		...(await discoverPresentationWorkspaces())
	]);
	for (const boundary of boundaries) await ensurePresentationStructure(boundary);
	for (const dir of ['Http', 'Cookies', 'Validation', 'Configuration', 'Services'])
		await fs.mkdir(path.join(getApplicationCorePath(), dir), { recursive: true });
	await fs.mkdir(getBootstrapPath(), { recursive: true });
	await initAliases();
	console.log('Folders updated. Existing files were preserved.');
}
