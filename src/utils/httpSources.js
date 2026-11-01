import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import { getApplicationCorePath, normalizePascalName } from './architecture.js';
export const datasourceName = (value) => {
	const name = normalizePascalName(value);
	return name.endsWith('Datasource') ? name : `${name}Datasource`;
};
export const httpSourcePath = (name) => path.join(getApplicationCorePath(), 'Http', datasourceName(name));
export const httpSourceImport = (name) => `#applicationCore/Http/${datasourceName(name)}`;
export async function discoverHttpSources() {
	try {
		return (await fs.readdir(path.join(getApplicationCorePath(), 'Http'), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && /^[A-Z][A-Za-z0-9]*Datasource$/.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
}
export async function selectHttpSource() {
	const names = await discoverHttpSources();
	if (names.length) {
		const { source } = await prompts({
			type: 'select',
			name: 'source',
			message: 'HTTP source:',
			choices: [...names.map((name) => ({ title: name, value: name })), { title: 'New HTTP source', value: '__new__' }]
		});
		if (!source) return undefined;
		if (source !== '__new__') return datasourceName(source);
	}
	const { name } = await prompts({ type: 'text', name: 'name', message: 'Datasource name:', initial: 'ApiDatasource' });
	return name === undefined ? undefined : datasourceName(String(name));
}
