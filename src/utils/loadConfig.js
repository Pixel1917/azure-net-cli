import path from 'path';
import { pathToFileURL } from 'url';

export async function loadUserConfig() {
    try {
        const configPath = path.resolve(process.cwd(), 'azure-net.config.js');
        const userConfig = await import(pathToFileURL(configPath));
        return userConfig.default || {};
    } catch {
        return {
            contexts: ['app'],
            defaultContext: 'app'
        };
    }
}