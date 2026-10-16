import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PEAK_RSS = new URL('./peak-rss.test-support.mjs', import.meta.url).href;
const MEBIBYTE = 1024 * 1024;

function measuredChild(bytes) {
  const program = `const retained = Buffer.alloc(${String(bytes)}, 3); process.stdout.write(String(retained.length));`;
  const run = spawnSync(process.execPath, ['--import', PEAK_RSS, '-e', program], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, String(bytes));
  const match = /PEAK_RSS_KIB (\d+)/u.exec(run.stderr);
  assert.ok(match, run.stderr);
  return Number(match[1]);
}

test('the peak probe detects a real whole-original allocation beyond the streaming budget', () => {
  const emptyPeak = measuredChild(0);
  const fullOriginalPeak = measuredChild(160 * MEBIBYTE);
  assert.ok(
    fullOriginalPeak - emptyPeak > 128 * 1024,
    'A whole original must violate 64 MiB growth',
  );
});

test(
  'Linux child peak excludes the fake server parent memory inherited before exec',
  {
    skip: process.platform !== 'linux',
  },
  () => {
    const retainedParentBytes = Buffer.alloc(160 * MEBIBYTE, 7);
    const childPeak = measuredChild(0);
    assert.equal(retainedParentBytes.length, 160 * MEBIBYTE);
    assert.ok(
      childPeak < 96 * 1024,
      `Empty child falsely included parent RSS: ${String(childPeak)} KiB`,
    );
  },
);
