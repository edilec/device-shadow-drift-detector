# Device Shadow Drift Detector

`device-shadow-drift-detector` compares an exported desired shadow with separately exported reported and observed field evidence. It classifies reconciled, stale, conflicting, missing, and ambiguous fields without reading or writing a device. Node.js 22+; no dependencies.

## Quick start

```sh
node bin/device-shadow-drift-detector.mjs --root examples --input passing.json
node bin/device-shadow-drift-detector.mjs --root examples --input failing.json
npm run check
```

The passing example exits `0`; the failing example exits `1` with `field-stale`. CLI configuration errors exit `2` with empty stdout. Unreadable, malformed, incomplete, or unsupported exports exit `2` with an `incomplete` JSON report. Stdout contains only that report. The real input path must remain inside the real `--root`, including through symlinks.

## Export format

```json
{
  "schemaVersion": "1",
  "complete": true,
  "desired": [{ "field": "opaque-lamp", "owner": "controller", "version": 2, "at": 20, "op": "set", "value": true }],
  "reported": [{ "field": "opaque-lamp", "owner": "controller", "version": 2, "at": 20, "op": "set", "value": true }],
  "observed": [{ "field": "opaque-lamp", "owner": "controller", "version": 2, "at": 20, "op": "set", "value": true }]
}
```

`desired`, `reported`, and `observed` are arrays of field records. A `set` operation requires a JSON scalar value (string, finite number, boolean, or null). A `delete` operation forbids `value`; it is an explicit tombstone, not an omitted field. `field` and `owner` are opaque 1–128-code-unit IDs. `version` and `at` are nonnegative safe integers; `at` is an exported virtual timestamp, not the process clock. An optional top-level string `note` is ignored and never reported. All other keys are rejected.

For each desired field, the newest reported and observed record is the highest `(version, at)` pair, not the last row. A lower-version row arriving later cannot overwrite it. Contradictory records at the same highest pair make evidence ambiguous. A desired field absent from either side is unknown, not deleted. A current record is stale when its version or timestamp predates desired; it conflicts when its operation, value, or owner differs. Matching current records, including matching tombstones, reconcile. A field found only on the reported or observed side is unexpected drift. Duplicate desired IDs are ambiguous. The export requires at least one desired field and an explicit `complete: true`.

## Rules and exits

| Rule | Severity | Status / exit |
| --- | --- | --- |
| `field-stale`, `field-conflict`, `field-unexpected` | error | fail / `1` |
| `input-unreadable`, `input-invalid`, `duplicate-key`, `byte-limit`, `record-limit`, `depth-limit`, `time-limit`, `export-incomplete`, `entry-invalid`, `no-fields`, `evidence-missing`, `evidence-ambiguous` | error | incomplete / `2` |

The report envelope has `schemaVersion`, `tool`, `status`, `summary`, `fields`, and `findings`. `fields` records zero-based desired, reported, and observed source ordinals and a state; it never copies field IDs, ownership strings, or values. Findings use the logical role `@export` and a JSON pointer to the exact file passed with `--input`; this is source provenance, not a fabricated path. Findings sort by UTF-16 code-unit `(location.file, location.pointer, ruleId)`.

## Limits and non-goals

Strict UTF-8 only. Maximum input 1,048,576 bytes, 200 records **per array**, JSON depth 3 (root at 0), 5,000 ms injected processing time. Exceeding any bound returns incomplete; exact N and N+1 tests cover each. Duplicate JSON keys (including escaped spelling) are refused. A read-only report has no `--out` and never sends device commands.

This tool cannot prove a physical device has converged. It trusts the provenance and completeness of the supplied local snapshots; it does not fetch cloud shadow state, resolve concurrent writers, inspect device logs, or reconcile fields. A stale or conflicting classification describes these exports only.
