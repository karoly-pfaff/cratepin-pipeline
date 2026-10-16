import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';

import {
  offlineBuild,
  reportOf,
  runWithoutNetwork,
  withProject,
} from '../building/projects.test-support.mjs';
import { runCliAsync } from '../support/cli-runs.test-support.mjs';
import {
  assertCacheConsistent,
  release,
  sha256Of,
  startPaused,
  stopRuns,
  treeOf,
  untilReached,
} from '../support/interleavings.test-support.mjs';

// A pull, a prune and a build interleaved on one cache by real CLI processes, one of them paused
// at a named file system step (see interleavings.test-support.mjs). Every outcome is decided by
// the order the pauses force, never by timing.

function cachePath(directory, ...names) {
  return join(directory, '.cratepin-cache', ...names);
}

function pull(directory) {
  return runCliAsync(directory, {}, 'pull', '--json');
}

function prune(directory) {
  return runWithoutNetwork(directory, 'cache', 'prune', '--json');
}

/** The run stopped with OUTPUT_CONFLICT (exit 9), naming a claim file of `kind`. */
function assertKeptOutBy(run, kind) {
  assert.equal(run.status, 9, run.stderr);
  assert.match(basename(reportOf(run).error.details.claimFile), new RegExp(`^${kind}-`, 'u'));
}

/** The cache entry name of a source file: the SHA-256 of its bytes. */
async function entryOf(directory, sourcePath) {
  return sha256Of(await readFile(join(directory, 'assets', 'source', ...sourcePath.split('/'))));
}

/** Cache entries the lock does not reference, which a prune that runs removes. */
async function writeStaleEntries(directory, texts) {
  const paths = texts.map((text) => cachePath(directory, 'originals', 'sha256', sha256Of(text)));
  for (const [index, path] of paths.entries()) await writeFile(path, texts[index]);
  return paths;
}

function isPresent(path) {
  return existsSync(path);
}

/** Lets the first half of every download through, then holds the rest until `gate` settles. */
function holdingDownloads(gate, halfSent) {
  return (request) =>
    request.method === 'GET'
      ? {
          midBody: () => {
            halfSent.resolve();
            return gate.promise;
          },
        }
      : undefined;
}

/**
 * Waits until the held download has its part file in the cache. It may still be empty: the
 * download holds back its latest chunk until the next one arrives.
 */
async function untilPartFileOpen(directory) {
  const incoming = cachePath(directory, 'incoming');
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    if ((await readdir(incoming)).some((name) => name.endsWith('.part'))) return;
    await delay(25);
  }
  assert.fail('the held download has no part file');
}

async function twoPullsPublishingOneEntry() {
  await withProject({ isWarm: false }, async (directory) => {
    const entry = await entryOf(directory, 'app/ui/button.png');
    const entryPath = cachePath(directory, 'originals', 'sha256', entry);
    const step = String.raw`link:\.part -> .*/originals/sha256/${entry}$:before`;
    const first = startPaused({ directory, label: 'first-pull', step }, 'pull', '--json');
    try {
      await untilReached(first);
      assert.ok(!isPresent(entryPath), 'the first pull has not published the entry yet');
      await assertCacheConsistent(directory);
      const second = await pull(directory);
      assert.equal(second.status, 0, second.stderr);
      const published = await readFile(entryPath);
      const firstEnd = await release(first);
      assert.equal(firstEnd.status, 0, firstEnd.stderr);
      assert.deepEqual(await readFile(entryPath), published, 'the earlier entry stays');
      await assertCacheConsistent(directory);
      assert.deepEqual(await readdir(cachePath(directory, 'incoming')), [], 'no part left');
      assert.deepEqual(await readdir(cachePath(directory, 'claims')), [], 'no claim left');
    } finally {
      await stopRuns(first);
    }
  });
}

async function pullPausedMidDownloadKeepsPruneOut() {
  await withProject({ isWarm: true }, async (directory, fake) => {
    const voice = await entryOf(directory, 'voice/hu/hello.mp3');
    await rm(cachePath(directory, 'originals', 'sha256', voice));
    const [stale] = await writeStaleEntries(directory, ['stale']);
    const gate = Promise.withResolvers();
    const halfSent = Promise.withResolvers();
    fake.planRequests(holdingDownloads(gate, halfSent));
    const pulling = pull(directory);
    try {
      await halfSent.promise;
      await untilPartFileOpen(directory);
      const refused = await prune(directory);
      assertKeptOutBy(refused, 'use');
      assert.deepEqual(reportOf(refused).facts.removed, []);
      assert.ok(isPresent(stale), 'the prune removed nothing');
      const incoming = await readdir(cachePath(directory, 'incoming'));
      assert.ok(
        incoming.some((name) => name.endsWith('.part')),
        'the download goes on',
      );
      await assertCacheConsistent(directory);
      gate.resolve();
      const pulled = await pulling;
      assert.equal(pulled.status, 0, pulled.stderr);
      await assertCacheConsistent(directory);
      assert.equal((await prune(directory)).status, 0);
      assert.ok(!isPresent(stale), 'a prune once the pull is done goes ahead');
    } finally {
      gate.resolve();
      await pulling;
    }
  });
}

async function prunePausedWhileRemovingKeepsOthersOut() {
  await withProject({ isWarm: true }, async (directory) => {
    const stale = await writeStaleEntries(directory, ['stale one', 'stale two']);
    const publicBefore = await treeOf(join(directory, 'public'));
    const step = String.raw`rm:/originals/sha256/[0-9a-f]{64}$:before`;
    const pruning = startPaused({ directory, label: 'prune', step }, 'cache', 'prune', '--json');
    try {
      await untilReached(pruning);
      assertKeptOutBy(await pull(directory), 'prune');
      assertKeptOutBy(await offlineBuild(directory), 'prune');
      assert.deepEqual(await treeOf(join(directory, 'public')), publicBefore, 'nothing published');
      assert.ok(stale.every(isPresent), 'the prune has not removed anything yet');
      await assertCacheConsistent(directory);
      const pruned = await release(pruning);
      assert.equal(pruned.status, 0, pruned.stderr);
      assert.equal(reportOf(pruned).facts.removed.length, 2);
      assert.ok(!stale.some(isPresent), 'the prune removed both');
      await assertCacheConsistent(directory);
      assert.equal((await pull(directory)).status, 0);
      assert.equal((await offlineBuild(directory)).status, 0);
    } finally {
      await stopRuns(pruning);
    }
  });
}

/**
 * The pull links its claim and stops before looking for others; the prune then links its own,
 * finds the pull's and stops as it withdraws; the pull, let go, finds the prune's. Each saw the
 * other's claim, so both back off.
 */
async function pullAndPruneClaimingAtOnce() {
  await withProject({ isWarm: true }, async (directory) => {
    const [stale] = await writeStaleEntries(directory, ['stale']);
    const pullStep = String.raw`link:/claims/use-[^/]*\.json$:after`;
    const pruneStep = String.raw`rm:/claims/prune-[^/]*\.json$:before`;
    const pulling = startPaused({ directory, label: 'pull', step: pullStep }, 'pull', '--json');
    let pruning;
    try {
      await untilReached(pulling);
      pruning = startPaused(
        { directory, label: 'prune', step: pruneStep },
        'cache',
        'prune',
        '--json',
      );
      await untilReached(pruning);
      assertKeptOutBy(await release(pulling), 'prune');
      assertKeptOutBy(await release(pruning), 'use');
      assert.ok(isPresent(stale), 'the prune removed nothing');
      assert.deepEqual(await readdir(cachePath(directory, 'claims')), [], 'both withdrew');
      await assertCacheConsistent(directory);
    } finally {
      await stopRuns(pulling, pruning);
    }
  });
}

async function pullCaughtWritingItsClaim() {
  await withProject({ isWarm: true }, async (directory) => {
    const [stale] = await writeStaleEntries(directory, ['stale']);
    const step = String.raw`writeFile:/claims/\.[^/]*\.tmp$:after`;
    const pulling = startPaused({ directory, label: 'pull', step }, 'pull', '--json');
    try {
      await untilReached(pulling);
      const pruned = await prune(directory);
      assert.equal(pruned.status, 0, pruned.stderr);
      assert.ok(!isPresent(stale), 'the prune went ahead');
      const failed = await release(pulling);
      assert.notEqual(failed.status, 0, 'the pull lost its claim file');
      assert.equal(reportOf(failed).error.code, 'IO_FAILED');
      assert.deepEqual(await readdir(cachePath(directory, 'claims')), [], 'no claim left');
      await assertCacheConsistent(directory);
      const again = await pull(directory);
      assert.equal(again.status, 0, again.stderr);
    } finally {
      await stopRuns(pulling);
    }
  });
}

describe('cache interleavings', { concurrency: true }, () => {
  test(
    'two pulls publishing one entry: the later link verifies the earlier entry and both succeed',
    twoPullsPublishingOneEntry,
  );
  test(
    'a pull paused mid-download keeps a prune out and the prune removes nothing',
    pullPausedMidDownloadKeepsPruneOut,
  );
  test(
    'a prune paused while removing keeps pulls and builds out until it is done',
    prunePausedWhileRemovingKeepsOthersOut,
  );
  test(
    'a pull and a prune that claim at once both back off and remove nothing',
    pullAndPruneClaimingAtOnce,
  );
  test(
    'a pull caught between writing and linking its claim fails cleanly while a prune runs',
    pullCaughtWritingItsClaim,
  );
});
