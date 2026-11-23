import { compareSpecs, differences, filterOperations, csvReport, parseSpec } from './model.mjs';
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const date = value => value ? new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : 'Not supplied';
const precise = value => value ? `${date(value)} · ${new Date(value).toISOString().slice(11, 16)} UTC` : 'Not supplied';
const option = (label, value) => { const node = el('option', label); node.value = value; return node; };
let captures = [], slots = new Map(), report = null, provenance = null, requestId = 0, selectedId = null, displayed = 100, localMode = false;
const cache = new Map();
async function readJSON(path) {
  if (!/^data\/(manifest\.json|captures\/[0-9TZ]+\.json|specs\/[a-f0-9]{64}\.json)$/.test(path)) throw new Error('Invalid archived data path.');
  if (!cache.has(path)) cache.set(path, fetch(`./${path}`, { credentials: 'omit' }).then(response => {
    if (!response.ok) throw new Error(`Cannot load the archived data (${response.status}). Please try again later.`);
    return response.json();
  }).catch(error => { cache.delete(path); throw error; }));
  return cache.get(path);
}
function link(label, href) {
  const node = el('a', label);
  try { const url = new URL(href); if (!['https:', 'http:'].includes(url.protocol)) return el('span', label); node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
  catch { return el('span', label); }
  return node;
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function makeSlots() {
  const id = $('api').value;
  slots = new Map();
  captures.forEach(capture => {
    const api = capture.apis.find(a => a.id === id);
    for (const version of api?.versions || []) {
      const key = `${capture.capturedAt}|${version.version}`;
      slots.set(key, { ...version, capturedAt: capture.capturedAt, apiId: id, apiTitle: api.title, preferred: api.preferred });
    }
  });
  $('before').replaceChildren(option('No comparison · inspect inventory', ''));
  $('after').replaceChildren();
  for (const [key, slot] of slots) {
    const label = `v${slot.version} · ${precise(slot.capturedAt)}`;
    $('before').append(option(label, key)); $('after').append(option(label, key));
  }
  const all = [...slots.entries()];
  const newest = all.filter(([, slot]) => slot.capturedAt === captures[0].capturedAt);
  const preferred = newest.find(([, slot]) => slot.version === slot.preferred) || newest.at(-1) || all[0];
  const earlierCapture = all.find(([, slot]) => slot.version === preferred?.[1].version && slot.capturedAt !== preferred?.[1].capturedAt);
  const otherVersion = newest.find(([key]) => key !== preferred?.[0]);
  $('after').value = preferred?.[0] || '';
  $('before').value = (earlierCapture || otherVersion)?.[0] || '';
  for (const id of ['api', 'before', 'after']) $(id).disabled = false;
}
function sourceCard(slot, side, inspected) {
  const card = el('div', undefined, 'source-card');
  card.append(el('div', side, 'source-label'));
  if (!slot) { card.append(el('h4', 'Inventory without a baseline'), el('p', 'Choose a “from” definition to compare. A missing baseline never counts as added operations.')); return card; }
  card.append(el('h4', `${inspected?.title || slot.apiTitle || 'Local definition'} · v${inspected?.version || slot.version}`));
  if (slot.local) {
    card.append(el('p', `Local file: ${slot.name}`), el('p', 'Read in this tab · not uploaded or retained'));
  } else {
    card.append(el('p', `Captured ${precise(slot.capturedAt)}`), el('p', `Directory updated ${precise(slot.directoryUpdated)}`));
    const links = el('div', undefined, 'source-links');
    links.append(link('Directory definition ↗', slot.source));
    const original = slot.originals?.find(origin => origin.url);
    if (original) links.append(link('Original source ↗', original.url));
    links.append(link('Retained JSON ↓', new URL(`./${slot.file}`, location.href).href));
    card.append(links, el('p', `Source license: ${slot.license?.name || 'Not supplied'}`), el('code', `SHA-256 ${slot.sha256.slice(0, 20)}… (full hash in export)`));
  }
  return card;
}
async function compareCollection() {
  const run = ++requestId;
  localMode = false; $('use-collection').hidden = true;
  for (const id of ['api', 'before', 'after']) $(id).disabled = false;
  const before = slots.get($('before').value) || null, after = slots.get($('after').value);
  if (!after) { notice('No retained definition is available for this selection.', true); return; }
  notice('Reading retained definitions…');
  try {
    const [a, b] = await Promise.all([before ? readJSON(before.file) : null, readJSON(after.file)]);
    if (run !== requestId) return;
    report = compareSpecs(a, b); provenance = { mode: 'collection', before, after, exportedAt: null };
    render();
  } catch (error) { if (run === requestId) notice(error.message, true); }
}
function render() {
  displayed = 100; selectedId = null;
  $('search').value = ''; $('status').value = 'all'; $('method-filter').value = 'all';
  $('sources').replaceChildren(sourceCard(provenance.before, 'From / baseline', report.before), sourceCard(provenance.after, 'To / target', report.after));
  const isSameCapture = provenance.before && !localMode && provenance.before.capturedAt === provenance.after.capturedAt;
  $('comparison-title').textContent = report.before ? `${report.before.version} → ${report.after.version}` : `${report.after.title} · definition inventory`;
  $('comparison-note').textContent = !report.before ? 'No earlier definition selected. Browse the published paths, authentication and shared schemas.' : localMode ? 'Two local definitions. All parsing and comparison happen in this browser tab.' : isSameCapture ? 'Two directory-listed versions, collected together. This comparison is not a measured change between capture dates.' : 'A comparison of retained observations. Changes reflect what was captured, not necessarily when the provider changed its service.';
  $('total-operations').textContent = report.after.operations.length;
  for (const name of ['added', 'removed', 'changed']) $(`count-${name}`).textContent = report.before ? report.counts[name] : '—';
  $('count-deprecated').textContent = report.after.operations.filter(op => op.deprecated).length;
  $('warnings').replaceChildren(...report.warnings.map(w => el('p', w)));
  $('schema-count').textContent = `${report.schemas.length} schemas${report.before ? ` · ${report.schemas.filter(s => !['unchanged', 'present'].includes(s.status)).length} changed entries` : ''}`;
  renderSchemas(); renderOperations();
  $('export-json').disabled = false; $('export-csv').disabled = false;
  const total = report.counts.added + report.counts.removed + report.counts.changed;
  notice(report.before ? `${total} operation changes found: ${report.counts.added} added, ${report.counts.removed} removed, ${report.counts.changed} changed. These are definition differences, not confirmed runtime behaviour.` : `${report.after.operations.length} operations available to inspect. A comparison will become available when another definition or capture is selected.`);
}
function renderOperations() {
  if (!report) return;
  const rows = filterOperations(report.operations, $('search').value, $('status').value, $('method-filter').value);
  const visible = rows.slice(0, displayed);
  $('shown-count').textContent = `${rows.length} of ${report.operations.length} entries`;
  $('operations').replaceChildren();
  if (!rows.length) $('operations').append(el('p', 'No operations match these filters. Try another path, method or change type.', 'empty'));
  if (!rows.some(row => row.id === selectedId)) selectedId = visible[0]?.id || null;
  for (const row of visible) {
    const button = el('button', undefined, 'operation'); button.type = 'button'; button.dataset.operation = row.id;
    button.setAttribute('aria-pressed', String(selectedId === row.id));
    const top = el('div', undefined, 'operation-top'); top.append(el('span', row.method, `verb ${row.method.toLowerCase()}`), el('span', row.path, 'op-path'));
    const tags = el('div', undefined, 'op-tags'); tags.append(el('span', row.status, `badge ${row.status}`));
    if (row.after?.deprecated) tags.append(el('span', 'Deprecated', 'badge deprecated'));
    if (row.categories.length) tags.append(el('span', row.categories.map(c => c.label).join(' · '), 'change-label'));
    button.append(top, el('div', row.title, 'op-summary'), tags);
    button.addEventListener('click', () => {
      selectedId = row.id; renderOperations();
      if (matchMedia('(max-width: 760px)').matches) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('operations').append(button);
  }
  $('show-more').hidden = rows.length <= displayed;
  const selected = rows.find(row => row.id === selectedId);
  if (selected) renderDetail(selected); else $('detail').replaceChildren(el('p', 'No operation is selected. Change the filters to inspect a definition.'));
}
function authLabel(auth) {
  const reqs = auth?.requirements;
  if (!Array.isArray(reqs) || !reqs.length) return 'No security requirement declared';
  return reqs.map(req => Object.keys(req).length ? Object.entries(req).map(([name, scopes]) => `${name}${scopes?.length ? ` (${scopes.join(', ')})` : ''}`).join(' + ') : 'Anonymous alternative').join(' OR ');
}
function excerpt(value) { const text = JSON.stringify(value, null, 2); return text?.length > 700 ? `${text.slice(0, 700)}…` : text || 'Not present'; }
function detailsJSON(title, value) {
  const detail = el('details'); detail.append(el('summary', title), el('pre', JSON.stringify(value, null, 2))); return detail;
}
function renderEvidence(before, after, container) {
  const changes = differences(before, after, 40);
  for (const change of changes.rows) {
    const node = el('div', undefined, 'evidence'); node.append(el('code', change.path));
    node.append(el('div', `− ${change.kind === 'added' ? 'Not present' : excerpt(change.before)}`, 'value before'), el('div', `+ ${change.kind === 'removed' ? 'Not present' : excerpt(change.after)}`, 'value after'));
    container.append(node);
  }
  if (changes.truncated) container.append(el('p', 'Showing the first 40 changed fields. Full normalized definitions are available below and in the evidence export.', 'evidence-intro'));
  if (!changes.rows.length) container.append(el('p', 'No structural differences in this entry.', 'evidence-intro'));
}
function renderDetail(row) {
  const node = $('detail'); node.replaceChildren(el('span', row.status, `badge ${row.status}`), el('h3', row.id), el('p', row.title));
  const current = row.after || row.before;
  const facts = el('dl');
  for (const [label, value] of [['Authentication', authLabel(current.auth)], ['Parameters', current.parameters.length], ['Response codes', Object.keys(current.responses).join(', ') || 'Not declared'], ['Deprecated', current.deprecated ? 'Yes' : 'No']]) facts.append(el('dt', label), el('dd', String(value)));
  node.append(facts);
  if (report.before) {
    node.append(el('h4', 'Change evidence'));
    if (row.status === 'added') node.append(el('p', 'This exact method and path exist only in the target definition.', 'evidence-intro'));
    else if (row.status === 'removed') node.append(el('p', 'This exact method and path exist only in the baseline. This does not prove that a live endpoint has stopped working.', 'evidence-intro'));
    else if (row.status === 'changed') renderEvidence(row.before, row.after, node);
    else node.append(el('p', 'This operation’s compared fields are unchanged. Other parts of the specification may differ.', 'evidence-intro'));
  }
  if (row.before) node.append(detailsJSON('Baseline definition · normalized', row.before));
  if (row.after) node.append(detailsJSON('Target definition · normalized', row.after));
}
function renderSchemas() {
  $('schemas').replaceChildren();
  if (!report.schemas.length) $('schemas').append(el('p', 'No named shared schemas in these definitions.', 'empty'));
  for (const row of report.schemas) {
    const button = el('button', undefined, 'schema-button'); button.type = 'button';
    button.append(el('span', row.name), el('span', row.status, `badge ${row.status}`));
    button.addEventListener('click', () => {
      $('detail').replaceChildren(el('span', row.status, `badge ${row.status}`), el('h3', row.name), el('p', 'Shared schema · raw definition (local references are shown by name)'));
      if (report.before) renderEvidence(row.before, row.after, $('detail'));
      if (row.before) $('detail').append(detailsJSON('Baseline schema', row.before));
      if (row.after) $('detail').append(detailsJSON('Target schema', row.after));
      $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('schemas').append(button);
  }
}
function save(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })); const anchor = el('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('api').addEventListener('change', () => { makeSlots(); compareCollection(); });
$('before').addEventListener('change', compareCollection); $('after').addEventListener('change', compareCollection);
for (const id of ['search', 'status', 'method-filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { displayed = 100; renderOperations(); });
$('show-more').addEventListener('click', () => { displayed += 100; renderOperations(); });
$('export-json').addEventListener('click', () => save('api-archaeology-evidence.json', JSON.stringify({ tool: 'API Archaeology', formatVersion: 1, ...provenance, exportedAt: new Date().toISOString(), method: 'Exact method/path matching; normalized structural comparison of published definitions; no runtime tests. External references are not fetched.', counts: report.counts, warnings: report.warnings, operations: report.operations, schemas: report.schemas }, null, 2), 'application/json'));
$('export-csv').addEventListener('click', () => save('api-archaeology-operations.csv', csvReport(report), 'text/csv;charset=utf-8'));
$('use-collection').addEventListener('click', () => { $('local-before').value = ''; $('local-after').value = ''; $('local-status').textContent = ''; compareCollection(); });
$('local-form').addEventListener('submit', async event => {
  event.preventDefault();
  const beforeFile = $('local-before').files[0], afterFile = $('local-after').files[0];
  if (!afterFile) { $('local-status').textContent = 'Select an after JSON file.'; return; }
  try {
    for (const file of [beforeFile, afterFile].filter(Boolean)) if (file.size > 10 * 1024 * 1024) throw new Error('Each JSON file must be under 10 MB.');
    const [before, after] = await Promise.all([beforeFile ? beforeFile.text().then(parseSpec) : null, afterFile.text().then(parseSpec)]);
    const compared = compareSpecs(before, after);
    ++requestId; localMode = true; report = compared;
    provenance = { mode: 'local', before: beforeFile ? { local: true, name: beforeFile.name } : null, after: { local: true, name: afterFile.name } };
    for (const id of ['api', 'before', 'after']) $(id).disabled = true;
    $('use-collection').hidden = false; $('local-status').textContent = 'Files read locally. Results are in the workbench above; nothing was uploaded.';
    render(); $('workbench').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { $('local-status').textContent = error.message; }
});
async function init() {
  try {
    const manifest = await readJSON('data/manifest.json');
    captures = await Promise.all(manifest.captures.map(capture => readJSON(capture.file)));
    if (!captures.length || !captures[0].apis?.length) throw new Error('The collection is empty. Local JSON comparison is still available below.');
    const latest = captures[0];
    $('api-count').textContent = latest.apis.length; $('version-count').textContent = latest.apis.reduce((n, api) => n + api.versions.length, 0); $('capture-count').textContent = captures.length; $('latest-date').textContent = precise(latest.capturedAt);
    $('api').replaceChildren(...latest.apis.map(api => option(`${api.title} · ${api.category}`, api.id)));
    $('history-note').textContent = captures.length === 1 ? 'One real capture is retained so far. No earlier collection history is invented. The next successful weekly run adds another observation; different directory versions can already be compared.' : `${captures.length} observations are retained. Select different capture dates in the workbench to inspect changes. Capture dates are not release dates.`;
    $('history').replaceChildren(...captures.slice(0, 8).map((capture, index) => {
      const item = el('li'); const when = el('time', date(capture.capturedAt)); when.dateTime = capture.capturedAt;
      item.append(when, el('span', `${capture.apis.length} APIs · ${capture.apis.reduce((n, a) => n + a.versions.length, 0)} definitions${index === captures.length - 1 ? ' · first retained baseline' : ''}`)); return item;
    }));
    makeSlots(); await compareCollection();
  } catch (error) { notice(`${error.message} You can still compare your own JSON files below.`, true); }
}
init();
