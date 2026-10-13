import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('the bundled offline preload blocks socket attempts', () => {
  const preload = new URL('./deny-network.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--import', preload,
    '--input-type=module',
    '-e', "import net from 'node:net'; net.connect({});",
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /network forbidden by test guard/);
});
