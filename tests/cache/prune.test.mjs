import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  objectKeyOf,
  runCliAsync,
  withTempDirectory,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';
import {
  release,
  startPaused,
  stopRuns,
  untilReached,
} from '../support/interleavings.test-support.mjs';

const SOURCES = { 'images/cat.png': 'cat', 'images/dog.png': 'dog', 'voice/hi.mp3': 'hi' };
const UUID = '0b5a4c1e-2f8d-4e3a-9c7b-1d2e3f405162';

/** A project with a pulled cache of SOURCES, read through the fake's anonymous public path. */
async function withPulledProject(usePulled) {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory(async (directory) => {
      const read = { transport: 'public-http', publicBaseUrl: fake.publicBaseUrl.href };
      await writeFile(
        join(directory, DEFAULT_CONFIG_FILE),
        JSON.stringify({ schemaVersion: 1, projectId: 'demo', r2: { read } }),
      );
      await writeSourceTree(directory, SOURCES);
      await commitCurrentLock(directory);
      for (const content of Object.values(SOURCES))
        fake.objects.set(objectKeyOf(content), Buffer.from(content));
      assert.equal((await runCliAsync(directory, {}, 'pull')).status, 0);
      await usePulled(fake, directory);
    });
  } finally {
    await fake.close();
  }
}

/** Every file under sourceDir with its content. */
async function sourceTreeOf(directory) {
  const root = join(directory, 'assets', 'source');
  const names = (await readdir(root, { recursive: true })).toSorted();
  return Promise.all(
    names.map(
      async (name) => `${name}:${await readFile(join(root, name), 'utf8').catch(() => 'dir')}`,
    ),
  );
}

function cachePath(directory, ...names) {
  return join(directory, '.cratepin-cache', ...names);
}

function removedNamesOf(rows) {
  return rows.map((row) => `${row.kind} ${row.name.split('/').pop().slice(0, 8)}`).toSorted();
}

function claimFileOf(row) {
  return row.claimFile;
}

function isUseClaim(name) {
  return name.startsWith('use-');
}

test('prune removes what the lock no longer needs; the next pull is still warm', async () => {
  await withPulledProject(async (fake, directory) => {
    await rm(join(directory, 'assets', 'source', 'voice'), { recursive: true });
    await commitCurrentLock(directory);
    // An author's file the lock does not reference (not selected by the patterns).
    await writeSourceTree(directory, { 'notes/draft.txt': 'work in progress' });
    const sourcesBefore = await sourceTreeOf(directory);
    const leftover = cachePath(directory, 'incoming', `${'a'.repeat(64)}.${UUID}.part`);
    await writeFile(leftover, 'half');
    const requestsBefore = fake.requests.length;
    const preview = await runCliAsync(directory, {}, 'cache', 'prune', '--dry-run', '--json');
    assert.equal(preview.status, 0, preview.stderr);
    const plan = JSON.parse(preview.stdout).facts;
    const hiEntry = `entry ${objectKeyOf('hi').split('/').pop().slice(0, 8)}`;
    assert.deepEqual(removedNamesOf(plan.wouldRemove), [hiEntry, 'part aaaaaaaa'].toSorted());
    assert.equal(plan.referencedCount, 2);
    assert.equal(await readFile(leftover, 'utf8'), 'half', 'a dry run removes nothing');
    const run = await runCliAsync(directory, {}, 'cache', 'prune', '--json');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).facts.removedBytes, 6);
    assert.equal(fake.requests.length, requestsBefore, 'storage is never contacted');
    assert.deepEqual(await readdir(cachePath(directory, 'incoming')), []);
    const pull = await runCliAsync(directory, {}, 'pull', '--offline', '--json');
    assert.equal(JSON.parse(pull.stdout).facts.cachedCount, 2);
    assert.deepEqual(
      await sourceTreeOf(directory),
      sourcesBefore,
      'the source directory is untouched',
    );
  });
});

test('prune refuses while a pull runs and goes ahead once it is done', async () => {
  await withPulledProject(async (_fake, directory) => {
    await rm(cachePath(directory, 'originals', 'sha256', objectKeyOf('hi').split('/').pop()));
    const step = String.raw`link: -> .*/claims/use-[^/]+[.]json$:after`;
    const pulling = startPaused({ directory, label: 'held-pull', step }, 'pull');
    try {
      await untilReached(pulling);
      // Model startup later than the former sixteen-second pacing window. Only release() can
      // end the overlap now: the pull is paused before any network timeout starts.
      await delay(18_000);
      const [refused, preview] = await Promise.all([
        runCliAsync(directory, {}, 'cache', 'prune', '--json'),
        runCliAsync(directory, {}, 'cache', 'prune', '--dry-run', '--json'),
      ]);
      assert.equal(refused.status, 9, refused.stderr);
      assert.match(JSON.parse(refused.stderr).error.details.claimFile, /use-/);
      assert.deepEqual(JSON.parse(refused.stderr).facts.removed, []);
      const liveNames = JSON.parse(preview.stdout).facts.liveClaims.map(claimFileOf);
      assert.ok(liveNames.some(isUseClaim), liveNames.join());
      assert.equal((await release(pulling)).status, 0);
      assert.equal((await runCliAsync(directory, {}, 'cache', 'prune')).status, 0);
    } finally {
      await stopRuns(pulling);
    }
  });
});

test('prune needs a committed lock; without a cache it has nothing to do', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(join(directory, DEFAULT_CONFIG_FILE), '{"schemaVersion":1,"projectId":"demo"}');
    assert.equal((await runCliAsync(directory, {}, 'cache', 'prune')).status, 10);
    await writeSourceTree(directory, SOURCES);
    await commitCurrentLock(directory);
    const run = await runCliAsync(directory, {}, 'cache', 'prune', '--json');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).facts.cacheExists, false);
    assert.equal((await readdir(directory)).includes('.cratepin-cache'), false);
  });
});
