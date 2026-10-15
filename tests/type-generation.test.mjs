import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { parseObjectInput } from '../src/generate/module/generateTypesJson.js';
import { extractInterfaceFields, updateRulesObject } from '../src/generate/module/generateSchemaFromType.js';

test('JSON and JS literals support nested objects without executing code', () => {
	const value = parseObjectInput(`{id: 42, nested: {value: '}'}, list: [1, 'two', null], enabled: true,}`);
	assert.equal(value.nested.value, '}');
	assert.deepEqual(value.list, [1, 'two', null]);
	assert.equal(parseObjectInput('{"description":{"value":"<p>text</p>"}').description.value, '<p>text</p>');
	for (const input of [
		'{value: process.exit(1)}',
		'{get value(){return 1}}',
		'{...process.env}',
		'{["computed"]:1}',
		'{}); globalThis.hacked=true; ({}',
		'[]'
	])
		assert.throws(() => parseObjectInput(input));
	assert.equal(parseObjectInput('{"__proto__": {"value": 1}}').__proto__.value, 1);
	assert.equal({}.value, undefined);
});

test('schema fields are top-level only; optionality, nested types and existing rules survive', () => {
	const fields = extractInterfaceFields('name: string; count?: number; nested: {name: string; extra:number}; "quoted-key"?: boolean;');
	assert.deepEqual(
		fields.map((x) => x.name),
		['name', 'count', 'nested', 'quoted-key']
	);
	const source = `export const Sample = Schema<IRequest>().rules((rules) => ({name: [rules.string()] // keep\n})).create();`;
	const result = updateRulesObject(source, fields);
	assert.match(result, /"count": \[rules.number\(\)\]/);
	assert.match(result, /"nested": \[rules.required\(\)\]/);
	assert.match(result, /"quoted-key": \[\]/);
	assert.match(result, /name: \[rules.string\(\)\]/);
	assert.equal(ts.transpileModule(result, { reportDiagnostics: true }).diagnostics.length, 0);
	assert.equal(updateRulesObject(result, fields), result);
});
