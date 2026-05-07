import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';
import { loadUserConfig } from './loadConfig.js';
const APP_PATH = path.join(process.cwd(), 'src/app');
function normalizeContextNames(rawContexts) {
	if (!Array.isArray(rawContexts)) return [];
	return rawContexts
		.map((item) => {
			if (typeof item === 'string') {
				return item.trim();
			}
			if (!item || typeof item !== 'object') return '';
			return String(item.name ?? '').trim();
		})
		.filter(Boolean);
}
export async function selectContext(message = 'Select context:') {
	const config = await loadUserConfig();
	const contexts = normalizeContextNames(config.contexts);
	const { context } = await prompts({
		type: 'select',
		name: 'context',
		message,
		choices: contexts.map((c) => ({ title: c, value: c }))
	});
	return context ? String(context) : null;
}
export function getContextPath(context) {
	return path.join(APP_PATH, context, 'layers');
}
export async function getAvailableFiles(dir, pattern = '.ts') {
	try {
		const files = await fs.readdir(dir);
		return files.filter((f) => f.endsWith(pattern) && f !== 'index.ts').map((f) => f.replace(pattern, ''));
	} catch {
		return [];
	}
}
export async function getApplicationProviderServices(context) {
	const contextPath = getContextPath(context);
	const providerPath = path.join(contextPath, 'application/providers/ApplicationProvider.ts');
	try {
		const content = await fs.readFile(providerPath, 'utf-8');
		// Extract service names from ApplicationProvider
		const serviceRegex = /(\w+Service):\s*\(/g;
		const services = [];
		let match;
		while ((match = serviceRegex.exec(content)) !== null) {
			const serviceName = match[1];
			if (serviceName) services.push(serviceName);
		}
		return services;
	} catch {
		return [];
	}
}
export function toPascalCase(str) {
	return str
		.split(/[-_\s]+/)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join('');
}
export function toCamelCase(str) {
	const pascal = toPascalCase(str);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
export function toKebabCase(str) {
	return str
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
		.toLowerCase();
}
