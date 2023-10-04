#!/usr/bin/env node
import { realpath, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { LIMITS, incomplete, parseStrictJson, detectDrift } from '../src/index.mjs';

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--root', '--input'].includes(key) || !argv[i + 1] || options[key]) return null;
    options[key] = argv[i + 1];
  }
  return options['--root'] && options['--input'] ? options : null;
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
const options = args(process.argv.slice(2));
if (!options) {
  process.stderr.write('Usage: device-shadow-drift-detector --root DIR --input FILE\n');
  process.exitCode = 2;
} else {
  let root;
  try {
    root = await realpath(options['--root']);
    if (!(await stat(root)).isDirectory()) root = null;
  } catch { root = null; }
  if (!root) {
    process.stderr.write('Invalid root directory.\n');
    process.exitCode = 2;
  } else {
  let result;
  try {
    const input = await realpath(resolve(root, options['--input']));
    if (!inside(root, input)) throw new Error('outside root');
    const bytes = await readFile(input);
    if (bytes.length > LIMITS.bytes) result = incomplete('byte-limit');
    else {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let data;
      try { data = parseStrictJson(raw); }
      catch (error) { result = incomplete(error.message === 'duplicate-key' || error.message === 'depth-limit' ? error.message : 'input-invalid'); }
      if (!result) result = detectDrift(data);
    }
  } catch { result = incomplete('input-unreadable'); }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
  }
}
