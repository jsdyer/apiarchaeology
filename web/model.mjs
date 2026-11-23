/** Pure OpenAPI/Swagger inspection. No network, storage or DOM access. */
export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function parseSpec(text) {
  if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) throw new Error('Each JSON file must be under 10 MB.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('That file is not valid JSON. Export the specification as JSON, not YAML.'); }
  validateSpec(value);
  return value;
}
export function validateSpec(spec) {
  if (!object(spec) || !(String(spec.openapi || '').startsWith('3.') || spec.swagger === '2.0')) throw new Error('Use an OpenAPI 3.x or Swagger 2.0 specification.');
  if (!object(spec.paths)) throw new Error('The specification needs a paths object. Webhooks-only definitions are not supported.');
  if (!object(spec.info)) throw new Error('The specification needs an info object.');
}
export function reference(spec, pointer) {
  if (!pointer.startsWith('#/')) return undefined;
  let current = spec;
  for (const part of pointer.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!object(current) && !Array.isArray(current)) return undefined;
    if (!own(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
export function expand(spec, value, trail = new Set(), depth = 0, budget = { remaining: 25000 }) {
  if (--budget.remaining < 0) return { $inspectionLimit: 'Structure exceeds 25,000 nodes' };
  if (depth > 70) return { $inspectionLimit: 'Nested structure exceeds 70 levels' };
  if (Array.isArray(value)) return value.map(v => expand(spec, v, trail, depth + 1, budget));
  if (!object(value)) return value;
  if (typeof value.$ref === 'string') {
    const target = reference(spec, value.$ref);
    if (target === undefined) return { ...value, $unresolvedRef: value.$ref };
    if (trail.has(value.$ref)) return { $ref: value.$ref, $recursive: true };
    const next = new Set(trail); next.add(value.$ref);
    const siblings = Object.fromEntries(Object.entries(value).filter(([k]) => k !== '$ref'));
    // Retain the original reference as evidence; changes to its target are also visible.
    return { $ref: value.$ref, $resolved: expand(spec, target, next, depth + 1, budget), ...(Object.keys(siblings).length ? { $siblings: expand(spec, siblings, next, depth + 1, budget) } : {}) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(spec, item, trail, depth + 1, budget)]));
}
function dereference(spec, item) {
  const visited = new Set();
  while (object(item) && typeof item.$ref === 'string' && !visited.has(item.$ref)) {
    visited.add(item.$ref);
    const target = reference(spec, item.$ref);
    if (target === undefined) return item;
    item = target;
  }
  return item;
}
function parameters(spec, path, operation) {
  const merged = new Map();
  for (const p of [...(Array.isArray(path.parameters) ? path.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
    const param = dereference(spec, p);
    merged.set(`${param?.in || ''}:${param?.name || stable(p)}`, expand(spec, p));
  }
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
function auth(spec, operation) {
  const security = own(operation, 'security') ? operation.security : spec.security || [];
  const requirements = Array.isArray(security) ? security.map(s => Object.fromEntries(Object.entries(s).sort().map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]))).sort((a, b) => stable(a).localeCompare(stable(b))) : security;
  const available = spec.components?.securitySchemes || spec.securityDefinitions || {};
  const names = new Set((Array.isArray(requirements) ? requirements : []).flatMap(s => Object.keys(s)));
  return { requirements, schemes: Object.fromEntries([...names].sort().map(name => [name, expand(spec, available[name] || { $missingScheme: name })])) };
}
export function inspect(spec) {
  validateSpec(spec);
  const operations = [];
  for (const [path, rawPath] of Object.entries(spec.paths)) {
    if (!path.startsWith('/')) continue;
    const pathItem = dereference(spec, rawPath);
    if (!object(pathItem)) continue;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!object(op)) continue;
      operations.push({
        id: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path,
        title: op.summary || op.operationId || 'Untitled operation',
        deprecated: op.deprecated === true,
        auth: auth(spec, op), parameters: parameters(spec, pathItem, op),
        request: expand(spec, op.requestBody || null), responses: expand(spec, op.responses || {}),
        servers: expand(spec, op.servers || pathItem.servers || spec.servers || { host: spec.host || '', basePath: spec.basePath || '', schemes: spec.schemes || [] }),
        documentation: { summary: op.summary || '', description: op.description || '', operationId: op.operationId || '', tags: op.tags || [] },
      });
    }
  }
  if (operations.length > 5000) throw new Error('This explorer supports up to 5,000 operations per definition. Split a larger specification before comparing.');
  operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const schemas = spec.components?.schemas || spec.definitions || {};
  const externalRefs = new Set();
  const missingRefs = new Set();
  function refs(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      if (!value.$ref.startsWith('#/')) externalRefs.add(value.$ref);
      else if (reference(spec, value.$ref) === undefined) missingRefs.add(value.$ref);
    }
    for (const item of Object.values(value)) refs(item);
  }
  refs(spec);
  return { title: spec.info.title || 'Untitled API', version: spec.info.version || 'Unspecified',
    format: spec.openapi || spec.swagger, operations, schemas,
    warnings: [...(stable(operations).includes('$inspectionLimit') ? ['Very deeply nested or highly expanded references reached the inspection limit. Some nested content was not compared.'] : []), ...(externalRefs.size ? [`${externalRefs.size} external references were not fetched. Their remote contents cannot be compared.`] : []), ...(missingRefs.size ? [`${missingRefs.size} local references could not be resolved.`] : [])] };
}
const categories = { auth: 'Authentication', deprecated: 'Deprecation', parameters: 'Parameters', request: 'Request body', responses: 'Responses / schemas', servers: 'Server addresses', documentation: 'Documentation' };
export function differences(before, after, limit = 120) {
  const rows = [];
  let truncated = false;
  function walk(a, b, path) {
    if (stable(a) === stable(b)) return;
    if (rows.length >= limit) { truncated = true; return; }
    if (object(a) && object(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[key], b[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    } else rows.push({ path: path || '/', before: a === undefined ? null : a, after: b === undefined ? null : b, kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed' });
  }
  walk(before, after, '');
  return { rows, truncated };
}
export function compareSpecs(beforeSpec, afterSpec) {
  const before = beforeSpec ? inspect(beforeSpec) : null;
  const after = inspect(afterSpec);
  const old = new Map((before?.operations || []).map(o => [o.id, o]));
  const next = new Map(after.operations.map(o => [o.id, o]));
  const operations = [...new Set([...old.keys(), ...next.keys()])].sort().map(id => {
    const a = old.get(id), b = next.get(id);
    const changed = a && b ? Object.entries(categories).filter(([key]) => stable(a[key]) !== stable(b[key])).map(([key, label]) => ({ key, label })) : [];
    return { id, method: (b || a).method, path: (b || a).path, title: (b || a).title,
      status: !before ? 'present' : !a ? 'added' : !b ? 'removed' : changed.length ? 'changed' : 'unchanged',
      categories: changed, before: a || null, after: b || null };
  });
  const schemas = [...new Set([...Object.keys(before?.schemas || {}), ...Object.keys(after.schemas)])].sort().map(name => {
    const a = before?.schemas[name], b = after.schemas[name];
    return { name, before: a ?? null, after: b ?? null, status: !before ? 'present' : a === undefined ? 'added' : b === undefined ? 'removed' : stable(a) === stable(b) ? 'unchanged' : 'changed' };
  });
  const counts = { present: 0, added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const row of operations) counts[row.status]++;
  return { before, after, operations, schemas, counts, warnings: [...new Set([...(before?.warnings || []), ...after.warnings])] };
}
export function filterOperations(rows, query = '', status = 'all', method = 'all') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => (status === 'all' || (status === 'deprecated' ? row.after?.deprecated : row.status === status)) && (method === 'all' || row.method === method) && words.every(word => `${row.id} ${row.title} ${row.categories.map(c => c.label).join(' ')}`.toLowerCase().includes(word)));
}
export function csvReport(report) {
  const quote = value => {
    const text = String(value ?? '');
    return `"${(/^[=+\-@\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`;
  };
  return [['status', 'method', 'path', 'summary', 'changes', 'deprecated'], ...report.operations.map(r => [r.status, r.method, r.path, r.title, r.categories.map(c => c.label).join('; '), r.after?.deprecated ?? ''])].map(row => row.map(quote).join(',')).join('\r\n');
}
