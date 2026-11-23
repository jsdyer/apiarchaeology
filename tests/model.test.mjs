import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareSpecs, inspect, parseSpec, filterOperations, csvReport, differences, stable } from '../web/model.mjs';
const spec = () => ({
  openapi: '3.0.3', info: { title: 'Test only', version: '1' }, security: [{ token: [] }],
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
    schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
  },
  paths: {
    '/pets': {
      parameters: [{ in: 'query', name: 'limit', schema: { type: 'integer' } }],
      get: { summary: 'List pets', responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
    },
    '/pets/{id}': { delete: { responses: { 204: { description: 'Deleted' } } } },
  },
});

test('matches exact method/path and reports actual additions, removals and referenced schema changes', () => {
  const before = spec(), after = structuredClone(before);
  delete after.paths['/pets/{id}']; after.paths['/new'] = { post: { responses: { 201: { description: 'Created' } } } };
  after.components.schemas.Pet.properties.name.maxLength = 100;
  const r = compareSpecs(before, after);
  assert.deepEqual(r.counts, { present: 0, added: 1, removed: 1, changed: 1, unchanged: 0 });
  assert.ok(r.operations.find(o => o.id === 'GET /pets').categories.some(c => c.key === 'responses'));
  assert.equal(r.schemas[0].status, 'changed');
});
test('inventory is not misrepresented as additions or prior history', () => {
  const r = compareSpecs(null, spec());
  assert.equal(r.counts.present, 2); assert.equal(r.counts.added, 0); assert.equal(r.before, null);
});
test('object key order does not create a false structural difference', () => {
  const a = spec(), b = JSON.parse(JSON.stringify(a)); b.components.schemas.Pet = { properties: { name: { type: 'string' } }, type: 'object' };
  assert.equal(compareSpecs(a, b).counts.unchanged, 2);
});
test('security inheritance, explicit anonymous operation, scopes and scheme details are compared', () => {
  const a = spec(), b = structuredClone(a); b.paths['/pets'].get.security = [];
  let row = compareSpecs(a, b).operations.find(r => r.id === 'GET /pets');
  assert.equal(row.categories[0].key, 'auth'); assert.deepEqual(row.after.auth.requirements, []);
  b.paths['/pets'].get.security = [{ token: [] }]; b.components.securitySchemes.token.scheme = 'basic';
  assert.ok(compareSpecs(a, b).operations.every(r => r.categories.some(c => c.key === 'auth')));
});
test('operation parameters override the same path parameter instead of duplicating it', () => {
  const a = spec(); a.paths['/pets'].get.parameters = [{ in: 'query', name: 'limit', required: true, schema: { type: 'integer' } }];
  const op = inspect(a).operations.find(o => o.id === 'GET /pets');
  assert.equal(op.parameters.length, 1); assert.equal(op.parameters[0].required, true);
});
test('deprecation changes and deprecated filter are distinct from removal', () => {
  const a = spec(), b = structuredClone(a); b.paths['/pets'].get.deprecated = true;
  const r = compareSpecs(a, b); assert.equal(r.counts.changed, 1); assert.equal(r.counts.removed, 0);
  assert.equal(filterOperations(r.operations, 'pets', 'deprecated').length, 1);
});
test('recursive schemas terminate and external references are explicitly unresolved', () => {
  const a = spec(); a.components.schemas.Pet.properties.parent = { $ref: '#/components/schemas/Pet' };
  a.paths['/pets'].get.requestBody = { $ref: 'https://example.invalid/remote.json#/Payload' };
  const inspected = inspect(a); assert.match(stable(inspected.operations), /\$recursive/);
  assert.match(inspected.warnings.join(' '), /external references were not fetched/);
});
test('JSON pointer escaping works for local references', () => {
  const a = spec(); a.components.schemas['A/B~C'] = { type: 'number' };
  a.paths['/pets'].get.requestBody = { content: { 'application/json': { schema: { $ref: '#/components/schemas/A~1B~0C' } } } };
  const op = inspect(a).operations.find(o => o.method === 'GET');
  assert.equal(op.request.content['application/json'].schema.$resolved.type, 'number');
});
test('Swagger 2 parameters, response definitions and root security are supported', () => {
  const a = { swagger: '2.0', info: { title: 'Old API', version: '2' }, securityDefinitions: { key: { type: 'apiKey', name: 'key', in: 'header' } }, security: [{ key: [] }], definitions: { Thing: { type: 'string' } }, paths: { '/thing': { get: { responses: { 200: { schema: { $ref: '#/definitions/Thing' } } } } } } };
  assert.equal(inspect(a).operations[0].responses['200'].schema.$resolved.type, 'string');
  assert.equal(inspect(a).operations[0].auth.schemes.key.type, 'apiKey');
});
test('invalid and YAML input fail with actionable errors; strings are not interpreted as HTML', () => {
  assert.throws(() => parseSpec('openapi: 3.0.0'), /not valid JSON/);
  assert.throws(() => parseSpec('{"hello":"world"}'), /OpenAPI/);
  const a = spec(); a.paths['/pets'].get.summary = '<img src=x onerror=alert(1)>';
  assert.equal(inspect(parseSpec(JSON.stringify(a))).operations.find(o => o.method === 'GET').title, a.paths['/pets'].get.summary);
});
test('CSV guards formula cells and evidence distinguishes missing from null', () => {
  const a = spec(); a.paths['/pets'].get.summary = '=HYPERLINK("bad")';
  assert.match(csvReport(compareSpecs(null, a)), /'=HYPERLINK/);
  const d = differences({ a: null }, { b: null });
  assert.deepEqual(d.rows.map(r => r.kind), ['removed', 'added']);
});
test('retained real baseline provides a genuine two-version comparison', () => {
  const base = new URL('../web/', import.meta.url); const manifest = JSON.parse(fs.readFileSync(new URL('data/manifest.json', base)));
  const capture = JSON.parse(fs.readFileSync(new URL(manifest.latest, base)));
  assert.equal(capture.apis.length, 6);
  const versions = capture.apis.find(a => a.id === 'apicurio.local:registry').versions;
  const a = JSON.parse(fs.readFileSync(new URL(versions[0].file, base))), b = JSON.parse(fs.readFileSync(new URL(versions[1].file, base)));
  const r = compareSpecs(a, b); assert.ok(r.counts.added > 0); assert.ok(r.counts.removed > 0); assert.ok(r.schemas.length > 0);
});
