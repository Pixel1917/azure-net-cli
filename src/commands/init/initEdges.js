import { injectIntoFile, writeIfNotExists } from '../../utils/fileUtils.js';
import path from 'path';

const hooksServerPath = path.join(process.cwd(), 'src/hooks.server.ts');

const hooksTemplate = `import { dev } from '$app/environment';
import { edgesHandle } from '@azure-net/kit/edges/server';
import { type Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
\treturn edgesHandle(
\t\tevent,
\t\tasync ({ edgesEvent, serialize }) => {
\t\t\treturn resolve(edgesEvent, {
\t\t\t\ttransformPageChunk: ({ html }) => serialize(html)
\t\t\t});
\t\t},
\t\tdev
\t);
};`;

export default async function initEdges() {
    const created = await writeIfNotExists(hooksServerPath, hooksTemplate);

    if (!created) {
        const importStatement = `import { edgesHandle } from '@azure-net/kit/edges/server';`;
        await injectIntoFile(hooksServerPath, 'import {', importStatement, 'before');

        const handleCode = `\treturn edgesHandle(
\t\tevent,
\t\tasync ({ edgesEvent, serialize }) => {`;

        await injectIntoFile(
            hooksServerPath,
            'export const handle: Handle = async ({ event, resolve }) => {',
            handleCode,
            'after'
        );
    }

    console.log('✅ Edges-svelte initialized');
}