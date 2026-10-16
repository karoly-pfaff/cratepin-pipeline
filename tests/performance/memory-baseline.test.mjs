import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';

import {
  DEFAULT_CONFIG_FILE,
  readerVariablesFor,
  startCli,
  withTempDirectory,
  writerVariablesFor,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

// Streams must keep memory flat in the size of an original: every command runs twice, over a
// 32 MiB and a 160 MiB original, and its peak memory may grow by at most half the 128 MiB
// difference. A command that read the original whole would grow by at least that much. Push
// measured a flat 163-175 MiB peak for 32, 96 and 256 MiB, with single runs up to about 55 MiB
// lower while garbage collection lags behind its multipart buffers, which the margin absorbs.
// The storage fake runs in this process, so the CLI's own memory is measured alone.

const MEBIBYTE = 1024 * 1024;
const PEAK_RSS_URL = new URL('./peak-rss.test-support.mjs', import.meta.url).href;
/** Half the 128 MiB the larger original adds, above the measured run-to-run noise. */
const MAX_GROWTH_KIB = 64 * 1024;

const STEPS = [
  { name: 'scan', args: ['scan'], variables: () => ({}) },
  { name: 'push', args: ['push'], variables: writerVariablesFor },
  { name: 'pull', args: ['pull'], variables: readerVariablesFor },
  { name: 'build', args: ['build', '--offline'], variables: () => ({}) },
];

function peakKibOf(run) {
  const match = /PEAK_RSS_KIB (\d+)/u.exec(run.stderr);
  assert.ok(match, run.stderr);
  return Number(match[1]);
}

async function runMeasured(directory, step, fake) {
  const start = {
    directory,
    variables: step.variables(fake),
    nodeOptions: ['--import', PEAK_RSS_URL],
  };
  const run = await startCli(start, ...step.args).finished;
  assert.equal(run.status, 0, `${step.name}: ${run.stderr}`);
  return peakKibOf(run);
}

/** Peak memory of each step for a project holding one copied original of `bytes`. */
async function peaksFor(bytes) {
  const fake = await FakeS3.start();
  try {
    const peaks = {};
    await withTempDirectory(async (directory) => {
      const limits = { multipartThresholdBytes: 5 * MEBIBYTE, multipartPartBytes: 5 * MEBIBYTE };
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        JSON.stringify({ schemaVersion: 1, projectId: 'demo', limits }),
      );
      await writeSourceTree(directory, { 'music/long.mp3': Buffer.alloc(bytes, 3) });
      await mkdir(join(directory, 'public'));
      for (const step of STEPS) peaks[step.name] = await runMeasured(directory, step, fake);
    });
    return peaks;
  } finally {
    await fake.close();
  }
}

test('scan, push, pull and build stream originals: peak memory stays flat in their size', async () => {
  const small = await peaksFor(32 * MEBIBYTE);
  const large = await peaksFor(160 * MEBIBYTE);
  for (const { name } of STEPS) {
    const growth = large[name] - small[name];
    assert.ok(growth < MAX_GROWTH_KIB, `${name} grew by ${String(growth)} KiB for 128 MiB more`);
  }
});
