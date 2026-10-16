import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { libvipsThreadsPerImage } from './sharp-settings.ts';

/** The libvips cache limits in a fresh process that imports only `module` and Sharp. */
function cacheLimitsAfterImporting(module: string): string {
  const script = `await import(${JSON.stringify(new URL(module, import.meta.url).href)});
const { default: sharp } = await import(${JSON.stringify(import.meta.resolve('sharp'))});
const { memory, files, items } = sharp.cache();
process.stdout.write([memory.max, files.max, items.max].join(','));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test('loading the converter or the image probe switches the libvips operation cache off', () => {
  assert.equal(cacheLimitsAfterImporting('./pixel-stages.ts'), '0,0,0');
  assert.equal(cacheLimitsAfterImporting('./image-probe.ts'), '0,0,0');
  assert.ok(libvipsThreadsPerImage() >= 1);
});
