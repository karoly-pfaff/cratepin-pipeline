import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  assertSentinelsKept,
  offlineBuild,
  runWithoutNetwork,
  snapshotOf,
  twoReleases,
  withProject,
  writeSentinel,
} from '../building/projects.test-support.mjs';

async function archiveCurrentRelease(directory) {
  const archiveDirectory = join(directory, 'release-archive');
  await mkdir(archiveDirectory);
  await cp(join(directory, '.cratepin-cache/originals'), join(archiveDirectory, 'originals'), {
    recursive: true,
  });
  await cp(join(directory, 'cratepin-lock.json'), join(archiveDirectory, 'cratepin-lock.json'));
  await cp(join(directory, 'cratepin.config.json'), join(archiveDirectory, 'cratepin.config.json'));
  return {
    archiveDirectory,
    outputInventory: await snapshotOf(join(directory, 'public/assets')),
    lockText: await readFile(join(directory, 'cratepin-lock.json'), 'utf8'),
  };
}

async function assertFailedRebuildKeptOutput(directory, inventory, missingCount) {
  const build = await offlineBuild(directory);
  assert.equal(build.status, 10, build.stderr);
  assert.ok(!build.stderr.includes('NETWORK_ATTEMPT'), build.stderr);
  const failure = JSON.parse(build.stderr);
  assert.equal(failure.error.code, 'NOT_FOUND');
  assert.equal(failure.error.details.missingCount, missingCount);
  assert.ok(failure.issues.some((issue) => issue.code === 'CACHE_MISS'));
  assert.deepEqual(await snapshotOf(join(directory, 'public/assets')), inventory);
}

async function loseCache(directory) {
  const cacheDirectory = join(directory, '.cratepin-cache');
  assert.equal(dirname(cacheDirectory), directory);
  await rm(cacheDirectory, { recursive: true });
}

async function restoreArchiveWithCorruptOriginal(directory, archive) {
  await cp(
    join(archive.archiveDirectory, 'originals'),
    join(directory, '.cratepin-cache/originals'),
    {
      recursive: true,
    },
  );
  const [asset] = JSON.parse(archive.lockText).assets;
  await writeFile(
    join(directory, '.cratepin-cache/originals/sha256', asset.sha256),
    'corrupt manual restoration',
  );
}

test('a released lock rebuilds its exact output from archived originals after cache loss, preserving author edits', async () => {
  await withProject({ isWarm: true }, async (directory, fake) => {
    await writeSentinel(directory);
    const firstBuild = await offlineBuild(directory);
    assert.equal(firstBuild.status, 0, firstBuild.stderr);
    const archive = await archiveCurrentRelease(directory);
    const releases = await twoReleases(directory);
    await releases.useSmaller();
    const secondBuild = await offlineBuild(directory);
    assert.equal(secondBuild.status, 0, secondBuild.stderr);
    const currentInventory = await snapshotOf(join(directory, 'public/assets'));
    assert.notDeepEqual(currentInventory, archive.outputInventory);
    const authorFile = join(directory, 'assets/source/app/ui/button.png');
    await writeFile(authorFile, 'a newer author edit must survive recovery');
    fake.objects.clear();
    await loseCache(directory);
    await writeFile(join(directory, 'cratepin-lock.json'), archive.lockText);
    await cp(
      join(archive.archiveDirectory, 'cratepin.config.json'),
      join(directory, 'cratepin.config.json'),
    );
    const cacheInitialization = await runWithoutNetwork(directory, 'pull', '--offline', '--json');
    assert.equal(cacheInitialization.status, 10, cacheInitialization.stderr);
    assert.equal(JSON.parse(cacheInitialization.stderr).error.code, 'NOT_FOUND');
    assert.ok(!cacheInitialization.stderr.includes('NETWORK_ATTEMPT'), cacheInitialization.stderr);
    await assertFailedRebuildKeptOutput(directory, currentInventory, 2);
    await restoreArchiveWithCorruptOriginal(directory, archive);
    await assertFailedRebuildKeptOutput(directory, currentInventory, 1);
    await cp(
      join(archive.archiveDirectory, 'originals'),
      join(directory, '.cratepin-cache/originals'),
      { recursive: true },
    );
    const restoredBuild = await offlineBuild(directory);
    assert.equal(restoredBuild.status, 0, restoredBuild.stderr);
    assert.ok(!restoredBuild.stderr.includes('NETWORK_ATTEMPT'), restoredBuild.stderr);
    assert.deepEqual(await snapshotOf(join(directory, 'public/assets')), archive.outputInventory);
    const verification = await runWithoutNetwork(directory, 'verify', '--json');
    assert.equal(verification.status, 0, verification.stderr);
    assert.equal(await readFile(authorFile, 'utf8'), 'a newer author edit must survive recovery');
    await assertSentinelsKept(directory);
  });
});
