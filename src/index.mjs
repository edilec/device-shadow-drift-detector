export const TOOL_ID = 'device-shadow-drift-detector';
export const LIMITS = Object.freeze({ bytes: 1_048_576, records: 200, depth: 3, milliseconds: 5000 });
export const RULE_SEVERITY = Object.freeze({
  'input-unreadable': 'error', 'input-invalid': 'error', 'duplicate-key': 'error', 'byte-limit': 'error', 'record-limit': 'error', 'depth-limit': 'error', 'time-limit': 'error', 'export-incomplete': 'error', 'entry-invalid': 'error', 'no-fields': 'error', 'evidence-missing': 'error', 'evidence-ambiguous': 'error',
  'field-stale': 'error', 'field-conflict': 'error', 'field-unexpected': 'error'
});
const UNKNOWN = new Set(['input-unreadable', 'input-invalid', 'duplicate-key', 'byte-limit', 'record-limit', 'depth-limit', 'time-limit', 'export-incomplete', 'entry-invalid', 'no-fields', 'evidence-missing', 'evidence-ambiguous']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const safeId = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v);
const scalar = v => v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
function finding(ruleId, pointer = '') {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  return { ruleId, severity: RULE_SEVERITY[ruleId], message: {
    'field-stale': 'The newest available evidence predates the desired field version or timestamp.',
    'field-conflict': 'Current field evidence disagrees with desired state or ownership.',
    'field-unexpected': 'Current evidence names a field absent from the desired snapshot.',
    'evidence-missing': 'Reported or observed evidence is absent for a desired field.',
    'evidence-ambiguous': 'Contradictory records have the same highest version and timestamp.'
  }[ruleId] ?? 'Field evidence cannot be evaluated safely.', location: { file: '@export', pointer } };
}
function report(findings, fields = []) {
  findings.sort((a, b) => compare(a.location.file, b.location.file) || compare(a.location.pointer, b.location.pointer) || compare(a.ruleId, b.ruleId));
  return { schemaVersion: '1', tool: TOOL_ID, status: findings.some(f => UNKNOWN.has(f.ruleId)) ? 'incomplete' : findings.length ? 'fail' : 'pass', summary: { checked: fields.length, errors: findings.length, warnings: 0 }, fields, findings };
}
export const incomplete = ruleId => report([finding(ruleId)]);
export function parseStrictJson(raw) {
  const value = JSON.parse(raw); let i = 0;
  const space = () => { while (/\s/u.test(raw[i] ?? '')) i++; };
  const token = () => { const start = i++; while (i < raw.length) { if (raw[i] === '\\') { i += 2; continue; } if (raw[i++] === '"') return JSON.parse(raw.slice(start, i)); } throw new Error('input-invalid'); };
  const walk = depth => { if (depth > LIMITS.depth) throw new Error('depth-limit'); space(); if (raw[i] === '{') { i++; space(); const keys = new Set(); while (raw[i] !== '}') { const key = token(); if (keys.has(key)) throw new Error('duplicate-key'); keys.add(key); space(); i++; walk(depth + 1); space(); if (raw[i] !== ',') break; i++; space(); } i++; return; } if (raw[i] === '[') { i++; space(); while (raw[i] !== ']') { walk(depth + 1); space(); if (raw[i] !== ',') break; i++; space(); } i++; return; } if (raw[i] === '"') { token(); return; } while (i < raw.length && !/[\s,}\]]/u.test(raw[i])) i++; };
  walk(0); return value;
}
function tooDeep(v, depth = 0) { return depth > LIMITS.depth || (v !== null && typeof v === 'object' && Object.values(v).some(child => tooDeep(child, depth + 1))); }
function validEntry(e) {
  if (!object(e) || !safeId(e.field) || !safeId(e.owner) || !Number.isSafeInteger(e.version) || e.version < 0 || !Number.isSafeInteger(e.at) || e.at < 0 || !['set', 'delete'].includes(e.op)) return false;
  if (e.op === 'set' ? !Object.hasOwn(e, 'value') || !scalar(e.value) : Object.hasOwn(e, 'value')) return false;
  return Object.keys(e).every(k => ['field', 'owner', 'version', 'at', 'op', 'value'].includes(k));
}
const sameState = (a, b) => a.owner === b.owner && a.op === b.op && (a.op === 'delete' || a.value === b.value);
function latest(rows, field) {
  let best = null, ordinal = -1, ambiguous = false;
  for (const [i, row] of rows.entries()) {
    if (row.field !== field) continue;
    const newer = best === null || row.version > best.version || (row.version === best.version && row.at > best.at);
    if (newer) { best = row; ordinal = i; ambiguous = false; }
    else if (row.version === best.version && row.at === best.at && !sameState(row, best)) ambiguous = true;
  }
  return { row: best, ordinal, ambiguous };
}
export function detectDrift(document, { now = Date.now } = {}) {
  const start = now(), expired = () => now() - start > LIMITS.milliseconds;
  if (!object(document)) return incomplete('input-invalid');
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(document)); } catch { return incomplete('input-invalid'); }
  if (bytes > LIMITS.bytes) return incomplete('byte-limit');
  if (tooDeep(document)) return incomplete('depth-limit');
  if (expired()) return incomplete('time-limit');
  if (document.schemaVersion !== '1' || !Array.isArray(document.desired) || !Array.isArray(document.reported) || !Array.isArray(document.observed) || Object.keys(document).some(k => !['schemaVersion', 'complete', 'desired', 'reported', 'observed', 'note'].includes(k)) || (document.note !== undefined && typeof document.note !== 'string')) return incomplete('input-invalid');
  if (document.complete !== true) return incomplete('export-incomplete');
  if ([document.desired, document.reported, document.observed].some(rows => rows.length > LIMITS.records)) return incomplete('record-limit');
  if (!document.desired.length) return incomplete('no-fields');
  for (const kind of ['desired', 'reported', 'observed']) for (const [i, entry] of document[kind].entries()) {
    if (expired()) return incomplete('time-limit');
    if (!validEntry(entry)) return report([finding('entry-invalid', `/${kind}/${i}`)]);
  }
  const findings = [], fields = [], desiredIds = new Set();
  for (const [i, want] of document.desired.entries()) {
    if (expired()) return incomplete('time-limit');
    const pointer = `/desired/${i}`;
    if (desiredIds.has(want.field)) { findings.push(finding('evidence-ambiguous', pointer)); continue; }
    desiredIds.add(want.field);
    const reported = latest(document.reported, want.field), observed = latest(document.observed, want.field);
    const field = { desiredOrdinal: i, state: 'unknown', reportedOrdinal: reported.ordinal, observedOrdinal: observed.ordinal };
    fields.push(field);
    if (reported.ambiguous || observed.ambiguous) findings.push(finding('evidence-ambiguous', pointer));
    else if (!reported.row || !observed.row) findings.push(finding('evidence-missing', pointer));
    else if (reported.row.version < want.version || observed.row.version < want.version || reported.row.at < want.at || observed.row.at < want.at) { field.state = 'stale'; findings.push(finding('field-stale', pointer)); }
    else if (!sameState(want, reported.row) || !sameState(want, observed.row) || !sameState(reported.row, observed.row)) { field.state = 'conflicting'; findings.push(finding('field-conflict', pointer)); }
    else field.state = 'reconciled';
  }
  for (const kind of ['reported', 'observed']) for (const [i, row] of document[kind].entries()) {
    if (expired()) return incomplete('time-limit');
    if (!desiredIds.has(row.field)) findings.push(finding('field-unexpected', `/${kind}/${i}`));
  }
  if (expired()) return incomplete('time-limit');
  return report(findings, fields);
}
