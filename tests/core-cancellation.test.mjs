import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import prompts from 'prompts';
import createDatasource from '../src/scaffolds/createDatasource.js';
import createResponse from '../src/scaffolds/createResponse.js';

async function fixture(run) {
	const previous = process.cwd();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-core-cancel-'));
	process.chdir(dir);
	try {
		await run(dir);
	} finally {
		prompts._injected = [];
		process.chdir(previous);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test('cancelling response creation never silently generates a raw datasource', () =>
	fixture(async () => {
		prompts.inject(['Api', true, new Error('cancel')]);
		await createDatasource();
		await assert.rejects(fs.access('src/app/ApplicationCore/Http/ApiDatasource/Datasource.ts'), { code: 'ENOENT' });
	}));

test('cancelling response wrapper prompt leaves the source untouched', () =>
	fixture(async () => {
		prompts.inject(['Api', new Error('cancel')]);
		await createResponse('ApiDatasource');
		await assert.rejects(fs.access('src/app/ApplicationCore/Http/ApiDatasource/ApiResponse.ts'), { code: 'ENOENT' });
	}));
