import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertSentinelsKept,
  attemptsIn,
  buildCrashingAt,
  offlineBuild,
  removeCrashedClaims,
  reportOf,
  twoReleases,
  withProject,
  writeSentinel,
} from './projects.test-support.mjs';

const GENERATION = { isWarm: true, outputMode: 'generation' };

function rootOf(directory) {
  return join(directory, 'public', 'assets');
}

async function manifestTextOf(directory) {
  return readFile(join(rootOf(directory), 'cratepin-manifest.json'), 'utf8');
}

async function generationNamesOf(directory) {
  return readdir(join(rootOf(directory), 'generations'));
}

test('a generation build publishes, keeps the previous generation and is unchanged offline', async () => {
  await withProject(GENERATION, async (directory) => {
    await writeSentinel(directory);
    const first = await offlineBuild(directory);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(attemptsIn(first), []);
    const releases = await twoReleases(directory);
    await releases.useSmaller();
    const second = reportOf(await offlineBuild(directory));
    assert.equal(second.facts.publication, 'published');
    assert.equal(second.facts.previousGeneration, reportOf(first).facts.generation);
    assert.equal((await generationNamesOf(directory)).length, 2);
    const manifest = JSON.parse(await manifestTextOf(directory));
    assert.equal(manifest.generation, second.facts.generation);
    assert.equal(reportOf(await offlineBuild(directory)).facts.publication, 'unchanged');
    await assertSentinelsKept(directory);
  });
});

/**
 * Where a generation build is ended abruptly and which manifest is published right after: before
 * the switch the old one, after it the new one; the old generation is never touched before.
 */
const CRASH_POINTS = [
  { crashAt: String.raw`rename:/generations/\.staging -> :before`, published: 'full' },
  { crashAt: String.raw`rename:/generations/\.staging -> :after`, published: 'full' },
  { crashAt: String.raw`rename:/\.cratepin-manifest\.json\.tmp -> :before`, published: 'full' },
  { crashAt: String.raw`rename:/\.cratepin-manifest\.json\.tmp -> :after`, published: 'smaller' },
];

/** Removes the kept generation `manifestText` names, so the next build stages it again. */
async function removeGenerationOf(directory, manifestText) {
  const { generation } = JSON.parse(manifestText);
  await rm(join(rootOf(directory), 'generations', generation.slice(0, 16)), {
    recursive: true,
    force: true,
  });
}

/** One crash from the full release towards the smaller one; the next build finishes the job. */
async function crashAndRepair({ directory, releases, manifests }, point) {
  await releases.useFull();
  assert.equal((await offlineBuild(directory)).status, 0);
  await releases.useSmaller();
  await removeGenerationOf(directory, manifests.smaller);
  const crashed = await buildCrashingAt(directory, point.crashAt);
  assert.notEqual(crashed.status, 0, `${point.crashAt}: the build was ended`);
  assert.equal(await manifestTextOf(directory), manifests[point.published], point.crashAt);
  await removeCrashedClaims(directory);
  const repaired = await offlineBuild(directory);
  assert.equal(repaired.status, 0, `${point.crashAt}: ${repaired.stderr}`);
  assert.equal(await manifestTextOf(directory), manifests.smaller, point.crashAt);
  const names = await generationNamesOf(directory);
  assert.ok(!names.includes('.staging'), `${point.crashAt}: no staging left`);
}

test('a generation build ended abruptly at any step keeps a complete published manifest', async () => {
  await withProject(GENERATION, async (directory) => {
    await writeSentinel(directory);
    const releases = await twoReleases(directory);
    await releases.useSmaller();
    assert.equal((await offlineBuild(directory)).status, 0);
    const smaller = await manifestTextOf(directory);
    await releases.useFull();
    assert.equal((await offlineBuild(directory)).status, 0);
    const manifests = { full: await manifestTextOf(directory), smaller };
    for (const point of CRASH_POINTS) {
      await crashAndRepair({ directory, releases, manifests }, point);
    }
    await assertSentinelsKept(directory);
  });
});

/** Another process holding `path` open for reading without letting it be replaced, as some readers do. */
async function holdWithoutDeleteSharing(path) {
  const script = `$f = [System.IO.File]::Open('${path}', 'Open', 'Read', 'Read'); Write-Output ready; Start-Sleep -Seconds 60`;
  const powershell = join(
    process.env.SystemRoot ?? 'C:/Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const holder = spawn(powershell, ['-NoProfile', '-Command', script]);
  const [chunk] = await once(holder.stdout, 'data');
  assert.match(String(chunk), /ready/u);
  return holder;
}

test(
  'a manifest held open by a reader keeps the old one published until it is closed',
  { skip: process.platform !== 'win32' && 'file sharing modes are Windows only' },
  async () => {
    await withProject(GENERATION, async (directory) => {
      assert.equal((await offlineBuild(directory)).status, 0);
      const oldManifest = await manifestTextOf(directory);
      const releases = await twoReleases(directory);
      await releases.useSmaller();
      const holder = await holdWithoutDeleteSharing(
        join(rootOf(directory), 'cratepin-manifest.json'),
      );
      try {
        const blocked = await offlineBuild(directory);
        assert.equal(blocked.status, 9, blocked.stderr);
        assert.equal(reportOf(blocked).error.details.reason, 'OUTPUT_IN_USE');
        assert.equal(await manifestTextOf(directory), oldManifest);
      } finally {
        holder.kill();
        await once(holder, 'close');
      }
      assert.equal(reportOf(await offlineBuild(directory)).facts.publication, 'published');
    });
  },
);
