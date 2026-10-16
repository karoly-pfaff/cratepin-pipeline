import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertSentinelsKept,
  attemptsIn,
  buildCrashingAt,
  issueSummariesOf,
  offlineBuild,
  removeCrashedClaims,
  reportOf,
  snapshotOf,
  twoReleases,
  withProject,
  writeSentinel,
} from './projects.test-support.mjs';
import { readerVariablesFor, runCliAsync } from '../support/cli-runs.test-support.mjs';

/** Every entry below the output root, or `{}` when there is none. */
async function outputOf(directory) {
  return snapshotOf(join(directory, 'public', 'assets')).catch(() => ({}));
}

function urlsOf(manifest) {
  return Object.values(manifest.assets)
    .map(({ url }) => url)
    .toSorted();
}

function missesOf(report) {
  return issueSummariesOf(report).filter((issue) => issue.startsWith('CACHE_MISS'));
}

test('a cold online build downloads, publishes beside the host page; offline it is unchanged', async () => {
  await withProject({ isWarm: false }, async (directory, fake) => {
    const run = await runCliAsync(directory, readerVariablesFor(fake), 'build', '--json');
    assert.equal(run.status, 0, run.stderr);
    const { facts } = reportOf(run);
    assert.deepEqual([facts.publication, facts.downloadedCount], ['published', 2]);
    assert.deepEqual((await readdir(join(directory, 'public'))).toSorted(), [
      'assets',
      'index.html',
    ]);
    const manifest = JSON.parse(
      await readFile(join(directory, 'public', 'assets', 'cratepin-manifest.json'), 'utf8'),
    );
    assert.deepEqual(urlsOf(manifest), ['assets/app/ui/button.webp', 'assets/voice/hu/hello.mp3']);
    const before = await snapshotOf(join(directory, 'public'));
    const again = await offlineBuild(directory);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(attemptsIn(again), [], 'offline contacts nothing');
    assert.equal(reportOf(again).facts.publication, 'unchanged');
    assert.deepEqual(await snapshotOf(join(directory, 'public')), before);
  });
});

test('an offline build on a cold cache names every miss and writes nothing to public', async () => {
  await withProject({ isWarm: false }, async (directory) => {
    const run = await offlineBuild(directory);
    assert.equal(run.status, 10);
    assert.deepEqual(attemptsIn(run), []);
    const report = reportOf(run);
    assert.equal(report.facts.publication, 'not-published');
    assert.deepEqual(missesOf(report), [
      'CACHE_MISS app/ui/button.png',
      'CACHE_MISS voice/hu/hello.mp3',
    ]);
    assert.deepEqual(await readdir(join(directory, 'public')), ['index.html']);
  });
});

test('an output directory the tool does not own is refused and left as it is', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    await mkdir(join(directory, 'public', 'assets'));
    await writeFile(join(directory, 'public', 'assets', 'legacy.png'), 'hand made');
    const before = await snapshotOf(join(directory, 'public'));
    const run = await offlineBuild(directory);
    assert.equal(run.status, 9);
    assert.equal(reportOf(run).error.details.reason, 'OUTPUT_NOT_OWNED');
    assert.deepEqual(await snapshotOf(join(directory, 'public')), before);
  });
});

/** A process whose working directory is inside the output, as a terminal there would be. */
async function holdOpen(directory) {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: directory });
  await once(holder, 'spawn');
  return holder;
}

test(
  'an output held open by another program stays as it was, and no staging is left',
  { skip: process.platform !== 'win32' && 'only Windows refuses to rename an open directory' },
  async () => {
    await withProject({ isWarm: true }, async (directory) => {
      assert.equal((await offlineBuild(directory)).status, 0);
      const before = await outputOf(directory);
      const releases = await twoReleases(directory);
      await releases.useSmaller();
      const holder = await holdOpen(join(directory, 'public', 'assets', 'app', 'ui'));
      try {
        const run = await offlineBuild(directory);
        assert.equal(run.status, 9, run.stderr);
        assert.equal(reportOf(run).error.details.reason, 'OUTPUT_IN_USE');
        assert.deepEqual(await outputOf(directory), before);
        assert.deepEqual((await readdir(join(directory, 'public'))).toSorted(), [
          'assets',
          'index.html',
        ]);
      } finally {
        holder.kill();
        await once(holder, 'close');
      }
      const after = await offlineBuild(directory);
      assert.equal(reportOf(after).facts.publication, 'published');
    });
  },
);

/**
 * Where a build is ended abruptly, what the output is right after, and what the next build
 * reports it recovered: before the swap (old), between its renames (missing), after its commit
 * (new) and while the old root is removed from the trash.
 */
const CRASH_POINTS = [
  { crashAt: 'rename:/assets -> :before', left: 'full', recovery: 'none' },
  { crashAt: 'rename:/assets -> :after', left: 'missing', recovery: 'rolled-back' },
  { crashAt: 'rename:/staging -> :before', left: 'missing', recovery: 'rolled-back' },
  { crashAt: 'rename:/staging -> :after', left: 'smaller', recovery: 'completed' },
  { crashAt: 'rename:/backup -> :after', left: 'smaller', recovery: 'none' },
  { crashAt: 'unlink:/trash/:after:2', left: 'smaller', recovery: 'none' },
];

/** One crash from the full release towards the smaller one; the next build repairs it. */
async function crashAndRecover({ directory, releases, outputs }, point) {
  await releases.useFull();
  assert.equal((await offlineBuild(directory)).status, 0);
  await releases.useSmaller();
  const crashed = await buildCrashingAt(directory, point.crashAt);
  assert.notEqual(crashed.status, 0, `${point.crashAt}: the build was ended`);
  assert.deepEqual(await outputOf(directory), outputs[point.left], `${point.crashAt}: left`);
  await removeCrashedClaims(directory);
  const recovered = await offlineBuild(directory);
  assert.equal(recovered.status, 0, `${point.crashAt}: ${recovered.stderr}`);
  assert.equal(reportOf(recovered).facts.recovery, point.recovery, point.crashAt);
  assert.deepEqual(await outputOf(directory), outputs.smaller);
  assert.deepEqual(
    (await readdir(join(directory, 'public'))).toSorted(),
    ['assets', 'index.html', 'other'],
    `${point.crashAt}: no work left`,
  );
}

test('a build ended abruptly at any swap step leaves an output the next build repairs', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    await writeSentinel(directory);
    const releases = await twoReleases(directory);
    await releases.useSmaller();
    assert.equal((await offlineBuild(directory)).status, 0);
    const smaller = await outputOf(directory);
    await releases.useFull();
    assert.equal((await offlineBuild(directory)).status, 0);
    const outputs = { full: await outputOf(directory), smaller, missing: {} };
    for (const point of CRASH_POINTS) {
      await crashAndRecover({ directory, releases, outputs }, point);
    }
    await assertSentinelsKept(directory);
  });
});

test('a source directory where builds keep their work is refused before anything is removed', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    const work = join(directory, 'public', '.assets.cratepin');
    await mkdir(join(work, 'staging'), { recursive: true });
    await writeFile(join(work, 'staging', 'mine.png'), 'an author file');
    const configFile = join(directory, 'cratepin.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(
      configFile,
      JSON.stringify({ ...config, sourceDir: 'public/.assets.cratepin' }),
    );
    const run = await offlineBuild(directory);
    assert.equal(run.status, 2, run.stderr);
    assert.equal(reportOf(run).error.code, 'CONFIG_INVALID');
    assert.equal(await readFile(join(work, 'staging', 'mine.png'), 'utf8'), 'an author file');
  });
});
