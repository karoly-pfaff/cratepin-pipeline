import assert from 'node:assert/strict';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { originalPathOf } from '../../cache/cache-layout.ts';
import { withBuildFixture } from '../../building/build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../../building/build-fixtures.test-support.ts';
import { runBuild } from '../../building/build-run.ts';
import { pngOf, transparentArtwork } from '../../media/testing/media-fixtures.test-support.ts';
import { workDirectoryOf } from '../../output/layout/work-directory.ts';
import { exitCodeOf } from '../../report.ts';
import type { OperationReport } from '../../report.ts';
import { buildRunReport } from './build-run-report.ts';

const CONFIG = {
  profiles: { 'ui-strict': { kind: 'image', webp: { lossless: true, keepSmaller: false } } },
};

async function originals(): Promise<FixtureOriginal[]> {
  return [
    {
      source: 'app/ui/button.png',
      bytes: await pngOf(transparentArtwork(9, 9)),
      profile: 'ui-strict',
    },
    {
      source: 'voice/hu/hello.mp3',
      bytes: Buffer.from('ID3 hello'),
      category: 'voice',
      locale: 'hu',
    },
  ];
}

function noReader(): never {
  throw new Error('a warm cache needs no read transport');
}

/** Builds offline exactly as the command does and reports the result. */
async function reportOf(fixture: BuildFixture): Promise<OperationReport> {
  const { project, lock } = fixture;
  const result = await runBuild({
    project,
    lock,
    isOffline: true,
    concurrency: 2,
    openReader: noReader,
  });
  return buildRunReport({ project, lock, isOffline: true }, result);
}

function lockedSha256(fixture: BuildFixture, index: number): string {
  const record = fixture.lock.assets[index];
  if (record === undefined) throw new Error(`No locked asset ${String(index)}`);
  return record.sha256;
}

function issuePathsOf(report: OperationReport): string[] {
  return report.issues.map(({ path }) => path);
}

function issueCodes(report: OperationReport): string[] {
  return report.issues.map(({ code }) => code);
}

test('a build reports what it published, the real sizes and how each output came to be', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const report = await reportOf(fixture);
    assert.equal(exitCodeOf(report), 0);
    const { facts } = report;
    assert.equal(facts.dryRun, false);
    assert.equal(facts.publication, 'published');
    assert.equal(facts.recovery, 'none');
    assert.match(facts.generation as string, /^[0-9a-f]{64}$/u);
    assert.equal(facts.assetCount, 2);
    assert.deepEqual([facts.copiedCount, facts.madeCount, facts.reusedCount], [1, 1, 0]);
    assert.equal(facts.savedBytes, Number(facts.sourceBytes) - Number(facts.outputBytes));
    assert.deepEqual(issueCodes(report), ['EXTENSION_CHANGED']);
  });
});

test('a second build reports the output unchanged and reuses every conversion', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const first = await reportOf(fixture);
    const again = await reportOf(fixture);
    assert.equal(again.facts.publication, 'unchanged');
    assert.equal(again.facts.generation, first.facts.generation);
    assert.deepEqual([again.facts.madeCount, again.facts.reusedCount], [0, 1]);
    assert.equal(again.facts.removedFileCount, 0);
  });
});

test('a build missing an original offline fails, names it and publishes nothing', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    await rm(originalPathOf(fixture.layout, lockedSha256(fixture, 1)));
    const report = await reportOf(fixture);
    assert.notEqual(exitCodeOf(report), 0);
    assert.equal(report.facts.publication, 'not-published');
    assert.ok(issuePathsOf(report).includes('voice/hu/hello.mp3'));
  });
});

test('a build that refuses an asset fails as invalid data and publishes nothing', async () => {
  const bad = { source: 'app/ui/bad.png', bytes: Buffer.from('not a png'), profile: 'ui-strict' };
  await withBuildFixture([bad], CONFIG, async (fixture) => {
    const report = await reportOf(fixture);
    assert.equal(exitCodeOf(report), 8);
    assert.equal(report.facts.publication, 'not-published');
    assert.deepEqual(issueCodes(report), ['IMAGE_UNREADABLE']);
  });
});

test('a lock the plan refuses fails at the plan, before any original is read', async () => {
  const clashing: FixtureOriginal[] = [
    { source: 'app/cat.png', bytes: await pngOf(transparentArtwork()), profile: 'ui-strict' },
    { source: 'app/cat.webp', bytes: Buffer.from('webp bytes'), id: 'cat-webp' },
  ];
  await withBuildFixture(clashing, CONFIG, async (fixture) => {
    await rm(originalPathOf(fixture.layout, lockedSha256(fixture, 0)));
    const report = await reportOf(fixture);
    assert.deepEqual([report.error?.code, exitCodeOf(report)], ['INVALID_DATA', 8]);
    assert.deepEqual(issueCodes(report), ['OUTPUT_PATH_COLLISION']);
    assert.equal(report.facts.publication, undefined);
  });
});

test('a build stopped after recovery fails with every fact and what recovery did', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    await reportOf(fixture);
    const work = workDirectoryOf(fixture.project.paths.outputRoot);
    await mkdir(work.directory);
    await rename(work.root, work.backup);
    await writeFile(join(work.backup, 'notes.txt'), 'mine');
    const report = await reportOf(fixture);
    assert.deepEqual(
      [report.error?.details.reason, exitCodeOf(report)],
      ['UNLISTED_OUTPUT_ENTRY', 9],
    );
    assert.deepEqual(
      [report.facts.recovery, report.facts.publication],
      ['rolled-back', 'not-published'],
    );
    assert.ok(issueCodes(report).includes('SWAP_ROLLED_BACK'));
  });
});
