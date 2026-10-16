import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  attemptsIn,
  issueSummariesOf,
  reportOf,
  runWithoutNetwork,
  snapshotOf,
  withProject,
} from './projects.test-support.mjs';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

test('an offline dry run on a warm cache reports the plan, contacts nothing and writes nothing', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    const before = await snapshotOf(directory);
    const run = await runWithoutNetwork(directory, 'build', '--dry-run', '--offline', '--json');
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(attemptsIn(run), []);
    const { facts } = reportOf(run);
    assert.equal(facts.dryRun, true);
    assert.equal(facts.outputRootState, 'absent');
    assert.equal(facts.outputUrlPath, 'assets');
    assert.deepEqual([facts.copiedCount, facts.wouldConvertCount], [1, 1]);
    assert.deepEqual(facts.pendingIds, ['app/ui/button']);
    assert.deepEqual(await snapshotOf(directory), before, 'not one byte changed');
    assert.deepEqual(await readdir(join(directory, 'public')), ['index.html']);
  });
});

test('an offline dry run on a cold cache fails as the build would, naming every miss', async () => {
  await withProject({ isWarm: false }, async (directory) => {
    const before = await snapshotOf(directory);
    const run = await runWithoutNetwork(directory, 'build', '--dry-run', '--offline', '--json');
    assert.equal(run.status, 10);
    assert.deepEqual(attemptsIn(run), []);
    const report = reportOf(run);
    assert.equal(report.error.code, 'NOT_FOUND');
    assert.deepEqual(issueSummariesOf(report), [
      'CACHE_MISS app/ui/button.png',
      'EXTENSION_CHANGED app/ui/button.png',
      'CACHE_MISS voice/hu/hello.mp3',
    ]);
    assert.deepEqual(await snapshotOf(directory), before);
  });
});

test('an online dry run on a cold cache resolves no credential and contacts nothing', async () => {
  await withProject({ isWarm: false, transport: 's3-readonly' }, async (directory) => {
    const before = await snapshotOf(directory);
    const run = await runWithoutNetwork(directory, 'build', '--dry-run', '--json');
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(attemptsIn(run), []);
    const { facts } = reportOf(run);
    assert.deepEqual([facts.wouldDownloadCount, facts.cachedCount], [2, 0]);
    assert.deepEqual(await snapshotOf(directory), before, 'no cache or output directory appeared');
  });
});

test('a plan problem stops the dry run first, even with an unowned root and a cold cache', async () => {
  await withProject({ isWarm: false }, async (directory) => {
    await writeSourceTree(directory, { 'app/ui/button.webp': 'webp bytes' });
    const configFile = join(directory, DEFAULT_CONFIG_FILE);
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    const assets = [{ source: 'app/ui/button.webp', id: 'ui.button-webp' }];
    await writeFile(configFile, JSON.stringify({ ...config, assets }));
    await commitCurrentLock(directory);
    await mkdir(join(directory, 'public', 'assets'));
    await writeFile(join(directory, 'public', 'assets', 'legacy.png'), 'not ours');
    const run = await runWithoutNetwork(directory, 'build', '--dry-run', '--offline', '--json');
    assert.equal(run.status, 8);
    assert.deepEqual(attemptsIn(run), []);
    const report = reportOf(run);
    assert.deepEqual(issueSummariesOf(report), ['OUTPUT_PATH_COLLISION app/ui/button.webp']);
    assert.equal(report.facts.outputRootState, undefined, 'the root was not even looked at');
  });
});
