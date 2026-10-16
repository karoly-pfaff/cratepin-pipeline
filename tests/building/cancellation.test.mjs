import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  offlineBuild,
  reportOf,
  snapshotOf,
  twoReleases,
  withProject,
} from './projects.test-support.mjs';
import { readerVariablesFor, runCliAsync, startCli } from '../support/cli-runs.test-support.mjs';

// Each test delivers the first Ctrl+C (SIGINT) to a real CLI run at one named step (see
// cancel-at.test-support.mjs) and checks what the command promises: exit 130 with CANCELLED, its
// own temporary files gone, its claim released, and nothing it had published lost.

const CANCEL_AT_URL = new URL('../support/cancel-at.test-support.mjs', import.meta.url).href;

function runCancelledAt({ directory, variables, cancelAt }, ...args) {
  const start = {
    directory,
    variables: { ...variables, CANCEL_AT: cancelAt },
    nodeOptions: ['--import', CANCEL_AT_URL],
  };
  return startCli(start, ...args).finished;
}

function cacheDirectory(directory, name) {
  return join(directory, '.cratepin-cache', name);
}

function isPart(name) {
  return name.endsWith('.part');
}

test('a pull cancelled mid-download stops with 130, removes its part files and claim', async () => {
  await withProject({ isWarm: false }, async (directory, fake) => {
    fake.simulate({ getBodyPacing: { chunkBytes: 1, pauseMs: 50 } });
    const run = await runCancelledAt(
      { directory, variables: readerVariablesFor(fake), cancelAt: 'createWriteStream:.part' },
      'pull',
      '--json',
    );
    assert.equal(run.status, 130, run.stderr);
    assert.equal(reportOf(run).error.code, 'CANCELLED');
    assert.deepEqual((await readdir(cacheDirectory(directory, 'incoming'))).filter(isPart), []);
    assert.deepEqual(await readdir(cacheDirectory(directory, 'claims')), []);
  });
});

test('a build cancelled as it stages keeps the published output and leaves no work directory', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    const releases = await twoReleases(directory);
    await releases.useSmaller();
    assert.equal((await offlineBuild(directory)).status, 0);
    const published = await snapshotOf(join(directory, 'public', 'assets'));
    await releases.useFull();
    const run = await runCancelledAt(
      { directory, variables: {}, cancelAt: 'mkdir:staging' },
      'build',
      '--offline',
      '--json',
    );
    assert.equal(run.status, 130, run.stderr);
    assert.deepEqual(await snapshotOf(join(directory, 'public', 'assets')), published);
    assert.deepEqual((await readdir(join(directory, 'public'))).toSorted(), [
      'assets',
      'index.html',
    ]);
    assert.deepEqual(await readdir(cacheDirectory(directory, 'claims')), []);
  });
});

/** Part files a crashed download left, named as the cache names them. */
const STRAY_PARTS = [
  `${'a'.repeat(64)}.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.part`,
  `${'b'.repeat(64)}.1b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.part`,
];

test('a cache prune cancelled after its first removal reports what it removed', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    for (const name of STRAY_PARTS) {
      await writeFile(join(cacheDirectory(directory, 'incoming'), name), 'left over');
    }
    const run = await runCancelledAt(
      { directory, variables: {}, cancelAt: 'rm:.part' },
      'cache',
      'prune',
      '--json',
    );
    assert.equal(run.status, 130, run.stderr);
    const report = reportOf(run);
    assert.equal(report.error.code, 'CANCELLED');
    assert.equal((await readdir(cacheDirectory(directory, 'incoming'))).filter(isPart).length, 1);
    assert.ok(JSON.stringify(report.facts).includes('.part'), 'the removed file is reported');
  });
});

test('after a cancelled pull, the next pull completes', async () => {
  await withProject({ isWarm: false }, async (directory, fake) => {
    fake.simulate({ getBodyPacing: { chunkBytes: 1, pauseMs: 50 } });
    const variables = readerVariablesFor(fake);
    const cancelAt = 'createWriteStream:.part';
    const cancelled = await runCancelledAt({ directory, variables, cancelAt }, 'pull', '--json');
    assert.equal(cancelled.status, 130, cancelled.stderr);
    assert.equal(reportOf(cancelled).error.code, 'CANCELLED');
    fake.simulate({ getBodyPacing: undefined });
    const rerun = await runCliAsync(directory, variables, 'pull', '--json');
    assert.equal(rerun.status, 0, rerun.stderr);
  });
});
