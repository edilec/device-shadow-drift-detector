import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectDrift, LIMITS, parseStrictJson } from '../src/index.mjs';

const entry = (field = 'lamp', version = 2, at = 20, op = 'set', value = true, owner = 'controller') => ({ field, owner, version, at, op, ...(op === 'set' ? { value } : {}) });
const doc = (desired = [entry()], reported = [entry()], observed = [entry()]) => ({ schemaVersion: '1', complete: true, desired, reported, observed });
const run = (root, input) => spawnSync(process.execPath, ['bin/device-shadow-drift-detector.mjs', '--root', root, '--input', input], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${new URL('../../migration-plan-template/support/deny-network.mjs', import.meta.url).href}` } });

test('good matching desired, reported, observed field is reconciled', () => {
  const r = detectDrift(doc()); assert.equal(r.status, 'pass'); assert.equal(r.summary.checked, 1);
  assert.deepEqual(r.fields, [{ desiredOrdinal: 0, state: 'reconciled', reportedOrdinal: 0, observedOrdinal: 0 }]); assert.deepEqual(r.findings, []);
});
test('JSON negative and positive zero compare as the same numeric value', () => {
  const r = detectDrift(doc([entry('meter', 1, 1, 'set', -0)], [entry('meter', 1, 1, 'set', 0)], [entry('meter', 1, 1, 'set', 0)]));
  assert.equal(r.status, 'pass');
});
test('out-of-order lower-version report cannot overwrite newer matching evidence', () => {
  const r = detectDrift(doc([entry('lamp', 3, 30)], [entry('lamp', 3, 30), entry('lamp', 2, 40, 'set', false)], [entry('lamp', 3, 30)]));
  assert.equal(r.status, 'pass'); assert.equal(r.fields[0].reportedOrdinal, 0);
});
test('old version or timestamp is stale, current divergent value and owner conflict', () => {
  assert.equal(detectDrift(doc([entry()], [entry('lamp', 1, 30)])).findings[0].ruleId, 'field-stale');
  assert.equal(detectDrift(doc([entry()], [entry('lamp', 2, 19)])).findings[0].ruleId, 'field-stale');
  assert.equal(detectDrift(doc([entry()], [entry('lamp', 2, 20, 'set', false)])).findings[0].ruleId, 'field-conflict');
  assert.equal(detectDrift(doc([entry()], [entry('lamp', 2, 20, 'set', true, 'other')])).findings[0].ruleId, 'field-conflict');
});
test('explicit deletion reconciles; omission is unknown; set null is not delete', () => {
  const tombstone = entry('lamp', 2, 20, 'delete'); assert.equal(detectDrift(doc([tombstone], [tombstone], [tombstone])).status, 'pass');
  const missing = detectDrift(doc([tombstone], [tombstone], [])); assert.equal(missing.status, 'incomplete'); assert.equal(missing.findings[0].ruleId, 'evidence-missing');
  const contrary = detectDrift(doc([tombstone], [entry('lamp', 2, 20, 'set', null)], [tombstone])); assert.equal(contrary.status, 'fail'); assert.equal(contrary.findings[0].ruleId, 'field-conflict');
});
test('same version and timestamp with contradictory values taints evidence', () => {
  const r = detectDrift(doc([entry()], [entry(), entry('lamp', 2, 20, 'set', false)]));
  assert.equal(r.status, 'incomplete'); assert.equal(r.findings[0].ruleId, 'evidence-ambiguous');
});
test('partial, invalid and empty exports cannot pass; reports never contain field values', () => {
  assert.equal(detectDrift({ ...doc(), complete: false }).status, 'incomplete');
  assert.equal(detectDrift(doc([], [], [])).status, 'incomplete');
  assert.equal(detectDrift(doc([entry('secret-canary')], [], [])).status, 'incomplete');
  assert.equal(JSON.stringify(detectDrift(doc([entry('secret-canary')], [], []))).includes('secret-canary'), false);
  assert.equal(detectDrift(doc([entry('lamp', 2, 20, 'delete')], [entry('lamp', 2, 20, 'delete')], [entry('lamp', 2, 20, 'delete')])).status, 'pass');
});
test('record, identifier, byte, depth and injected time limits enforce N and N+1', () => {
  const desired = Array.from({ length: LIMITS.records }, (_, i) => entry(`f${i}`));
  assert.equal(detectDrift(doc(desired, desired, desired)).status, 'pass');
  assert.equal(detectDrift(doc(desired.concat(entry('extra')), desired, desired)).findings[0].ruleId, 'record-limit');
  assert.equal(detectDrift(doc([entry('x'.repeat(128))], [entry('x'.repeat(128))], [entry('x'.repeat(128))])).status, 'pass');
  assert.equal(detectDrift(doc([entry('x'.repeat(129))])).status, 'incomplete');
  const x = doc(); x.note = ''; const overhead = Buffer.byteLength(JSON.stringify(x)); x.note = 'x'.repeat(LIMITS.bytes - overhead); assert.equal(detectDrift(x).status, 'pass'); x.note += 'x'; assert.equal(detectDrift(x).findings[0].ruleId, 'byte-limit');
  const deep = doc(); assert.equal(detectDrift(deep).status, 'pass'); deep.desired[0].value = { nested: 'x' }; assert.equal(detectDrift(deep).findings[0].ruleId, 'depth-limit');
  assert.equal(detectDrift(doc(), { now: (() => { let n = 0; return () => n++ ? LIMITS.milliseconds : 0; })() }).status, 'pass');
  assert.equal(detectDrift(doc(), { now: (() => { let n = 0; return () => n++ ? LIMITS.milliseconds + 1 : 0; })() }).findings[0].ruleId, 'time-limit');
});
test('duplicate keys including escaped spelling are rejected', () => assert.throws(() => parseStrictJson('{"complete":false,"complet\\u0065":true}'), /duplicate-key/));
test('CLI confines reads, decodes strictly, and invalid usage has empty stdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shadow-')); await writeFile(join(root, 'good.json'), JSON.stringify(doc())); assert.equal(run(root, 'good.json').status, 0);
  await writeFile(join(root, 'bad.json'), Buffer.from([0xff])); assert.equal(JSON.parse(run(root, 'bad.json').stdout).status, 'incomplete');
  await symlink(tmpdir(), join(root, 'escape')); const escaped = run(root, 'escape/no.json'); assert.equal(escaped.status, 2); assert.equal(JSON.parse(escaped.stdout).status, 'incomplete');
  const invalidRoot = run(join(root, 'no-directory'), 'good.json'); assert.equal(invalidRoot.status, 2); assert.equal(invalidRoot.stdout, '');
  const usage = spawnSync(process.execPath, ['bin/device-shadow-drift-detector.mjs', '--root', root, '--input', 'good.json', '--bad'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }); assert.equal(usage.status, 2); assert.equal(usage.stdout, '');
});
