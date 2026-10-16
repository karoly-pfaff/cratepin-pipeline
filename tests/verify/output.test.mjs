import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  attemptsIn,
  offlineBuild,
  reportOf,
  runWithoutNetwork,
  withProject,
} from '../building/projects.test-support.mjs';
import { DEFAULT_CONFIG_FILE } from '../support/cli-runs.test-support.mjs';

function issueCodesOf(report) {
  return report.issues.map(({ code }) => code);
}

function verify(directory) {
  return runWithoutNetwork(directory, 'verify', '--json');
}

test('verify passes a fresh build, contacting nothing, and fails a changed file with exit 7', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    assert.equal((await offlineBuild(directory)).status, 0);
    const clean = await verify(directory);
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(attemptsIn(clean), []);
    assert.deepEqual([reportOf(clean).facts.assetCount, reportOf(clean).facts.fileCount], [2, 2]);
    const published = join(directory, 'public', 'assets', 'voice', 'hu', 'hello.mp3');
    const source = join(directory, 'assets', 'source', 'voice', 'hu', 'hello.mp3');
    assert.ok(
      (await readFile(published)).equals(await readFile(source)),
      'the copy is the original',
    );
    await writeFile(join(directory, 'public', 'assets', 'voice', 'hu', 'hello.mp3'), 'changed');
    const changed = await verify(directory);
    assert.equal(changed.status, 7);
    assert.deepEqual(issueCodesOf(reportOf(changed)), ['OUTPUT_MISMATCH']);
  });
});

test('verify without a published output fails with exit 10 and takes no --offline', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    assert.equal((await verify(directory)).status, 10);
    assert.equal((await runWithoutNetwork(directory, 'verify', '--offline')).status, 4);
  });
});

test('verify fails with exit 9 for a file the tool did not publish and 8 for a stale output', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    assert.equal((await offlineBuild(directory)).status, 0);
    const extra = join(directory, 'public', 'assets', 'notes.txt');
    await writeFile(extra, 'mine');
    const conflict = await verify(directory);
    assert.equal(conflict.status, 9);
    assert.deepEqual(issueCodesOf(reportOf(conflict)), ['UNLISTED_OUTPUT_ENTRY']);
    await rm(extra);
    const configFile = join(directory, DEFAULT_CONFIG_FILE);
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(
      configFile,
      JSON.stringify({ ...config, profiles: { 'ui-strict': { kind: 'copy' } } }),
    );
    const stale = await verify(directory);
    assert.equal(stale.status, 8);
    assert.deepEqual([...new Set(issueCodesOf(reportOf(stale)))], ['MANIFEST_STALE']);
  });
});
