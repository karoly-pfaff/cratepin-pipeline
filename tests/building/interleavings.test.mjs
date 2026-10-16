import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';

import {
  assertSentinelsKept,
  offlineBuild,
  reportOf,
  runWithoutNetwork,
  twoReleases,
  withProject,
  writeSentinel,
} from './projects.test-support.mjs';
import {
  commitCurrentLock,
  DEFAULT_CONFIG_FILE,
  runCliAsync,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';
import {
  assertCacheConsistent,
  assertPublicConsistent,
  release,
  startPaused,
  stopRuns,
  treeOf,
  untilReached,
} from '../support/interleavings.test-support.mjs';

// Builds interleaved with other builds, prunes, pulls, verify and readers, by real CLI processes,
// one paused at a named file system step (see interleavings.test-support.mjs). Where a mix of two
// outputs could pass for one, the runs build two different locks.

const PATH_PRESERVING = 'path-preserving';
const BUILD = ['build', '--offline', '--json'];
/** The last file a path-preserving build stages; everything before it is written by then. */
const STAGING_MANIFEST = String.raw`createWriteStream:/\.assets\.cratepin/staging/cratepin-manifest\.json$:before`;

function rootOf(directory) {
  return join(directory, 'public', 'assets');
}

function workOf(directory) {
  return join(directory, 'public', '.assets.cratepin');
}

function verify(directory, ...options) {
  return runWithoutNetwork(directory, 'verify', ...options, '--json');
}

function prune(directory) {
  return runWithoutNetwork(directory, 'cache', 'prune', '--json');
}

function pull(directory) {
  return runCliAsync(directory, {}, 'pull', '--json');
}

/** The run stopped with OUTPUT_CONFLICT (exit 9), naming a build claim file. */
function assertKeptOutByBuild(run) {
  assert.equal(run.status, 9, run.stderr);
  assert.match(basename(reportOf(run).error.details.claimFile), /^build-.*\.json$/u);
}

function assertSucceeded(run) {
  assert.equal(run.status, 0, run.stderr);
}

/** Builds both releases, the full one last; returns the output tree of each. */
async function publishBoth(directory, releases) {
  await releases.useSmaller();
  assertSucceeded(await offlineBuild(directory));
  const smaller = await treeOf(rootOf(directory));
  await releases.useFull();
  assertSucceeded(await offlineBuild(directory));
  return { smaller, full: await treeOf(rootOf(directory)) };
}

async function buildPausedBetweenRenames() {
  await withProject({ isWarm: true }, async (directory) => {
    await writeSentinel(directory);
    const releases = await twoReleases(directory);
    const trees = await publishBoth(directory, releases);
    await releases.useSmaller();
    const step = 'rename:/assets -> .*/backup$:after';
    const swapping = startPaused({ directory, label: 'build', step }, ...BUILD);
    try {
      await untilReached(swapping);
      const inFlight = await treeOf(workOf(directory));
      await assertPublicConsistent(directory, {
        mode: PATH_PRESERVING,
        trees: [],
        backupTree: trees.full,
      });
      await releases.useFull();
      assertKeptOutByBuild(await offlineBuild(directory));
      assertKeptOutByBuild(await prune(directory));
      assert.notEqual((await verify(directory)).status, 0, 'verify never passes a missing root');
      assertSucceeded(await pull(directory));
      assert.deepEqual(await treeOf(workOf(directory)), inFlight, 'nothing recovered the swap');
      await releases.useSmaller();
      assertSucceeded(await release(swapping));
      await assertPublicConsistent(directory, { mode: PATH_PRESERVING, trees: [trees.smaller] });
      assertSucceeded(await verify(directory));
      await assertSentinelsKept(directory);
    } finally {
      await stopRuns(swapping);
    }
  });
}

function issueCodesOf(run) {
  return reportOf(run).issues.map(({ code }) => code);
}

async function buildPausedWhileStaging() {
  await withProject({ isWarm: true }, async (directory) => {
    await writeSentinel(directory);
    const releases = await twoReleases(directory);
    const trees = await publishBoth(directory, releases);
    await releases.useSmaller();
    const staging = startPaused({ directory, label: 'build', step: STAGING_MANIFEST }, ...BUILD);
    try {
      await untilReached(staging);
      await assertPublicConsistent(directory, { mode: PATH_PRESERVING, trees: [trees.full] });
      const staged = await treeOf(join(workOf(directory), 'staging'));
      assert.ok(Object.keys(staged).length > 0, 'part of the next output is staged');
      const interrupted = await verify(directory);
      assert.equal(interrupted.status, 9, interrupted.stderr);
      assert.ok(issueCodesOf(interrupted).includes('INTERRUPTED_PUBLICATION'));
      assertSucceeded(await release(staging));
      await assertPublicConsistent(directory, { mode: PATH_PRESERVING, trees: [trees.smaller] });
      assertSucceeded(await verify(directory));
      await assertSentinelsKept(directory);
    } finally {
      await stopRuns(staging);
    }
  });
}

/**
 * The first build links its cache claim and stops before looking for others; the second links
 * its own, finds the first's and stops as it withdraws; the first, let go, finds the second's.
 * Each saw the other's claim, so both back off.
 */
async function twoBuildsClaimingAtOnce() {
  await withProject({ isWarm: true }, async (directory) => {
    await writeSentinel(directory);
    const releases = await twoReleases(directory);
    await releases.useFull();
    assertSucceeded(await offlineBuild(directory));
    const full = await treeOf(rootOf(directory));
    await releases.useSmaller();
    const linked = String.raw`link:/\.cratepin-cache/claims/build-[^/]*\.json$:after`;
    const withdrawing = String.raw`rm:/\.cratepin-cache/claims/build-[^/]*\.json$:before`;
    const first = startPaused({ directory, label: 'first', step: linked }, ...BUILD);
    let second;
    try {
      await untilReached(first);
      second = startPaused({ directory, label: 'second', step: withdrawing }, ...BUILD);
      await untilReached(second);
      assertKeptOutByBuild(await release(first));
      assertKeptOutByBuild(await release(second));
      await assertPublicConsistent(directory, { mode: PATH_PRESERVING, trees: [full] });
      assert.deepEqual(await readdir(join(directory, 'public')), ['assets', 'index.html', 'other']);
      await assertSentinelsKept(directory);
    } finally {
      await stopRuns(first, second);
    }
  });
}

async function manifestGenerationOf(directory) {
  return JSON.parse(await readFile(join(rootOf(directory), 'cratepin-manifest.json'), 'utf8'))
    .generation;
}

/** A third release beside `twoReleases`: the voice line without the image. */
async function voiceOnlyRelease(directory) {
  const lockFile = join(directory, 'cratepin-lock.json');
  const current = await readFile(lockFile, 'utf8');
  await writeSourceTree(directory, { 'voice/hu/hello.mp3': 'ID3 hello' });
  await rm(join(directory, 'assets', 'source', 'app'), { recursive: true });
  await commitCurrentLock(directory);
  const voiceOnly = await readFile(lockFile, 'utf8');
  await writeFile(lockFile, current);
  return () => writeFile(lockFile, voiceOnly);
}

/**
 * Builds the committed lock paused at `step`; while it waits, a reader process finds the
 * manifest naming `expected`, complete. Returns the generation it published.
 */
async function buildReadAt(directory, { label, step, expected }) {
  const paused = startPaused({ directory, label, step }, ...BUILD);
  try {
    await untilReached(paused);
    await assertPublicConsistent(directory, { mode: 'generation', generations: [expected] });
    await assertSentinelsKept(directory);
    assertSucceeded(await release(paused));
    return await manifestGenerationOf(directory);
  } finally {
    await stopRuns(paused);
  }
}

/**
 * Three releases, so every build also retires a generation: before its switch the old manifest
 * is read, after it the new one, and while an old generation is removed from the trash the
 * manifest still names a complete one.
 */
async function generationBuildPausedAroundItsSwitch() {
  await withProject({ isWarm: true, outputMode: 'generation' }, async (directory) => {
    await writeSentinel(directory);
    const releases = await twoReleases(directory);
    const useVoiceOnly = await voiceOnlyRelease(directory);
    await releases.useFull();
    assertSucceeded(await offlineBuild(directory));
    const full = await manifestGenerationOf(directory);
    await releases.useSmaller();
    assertSucceeded(await offlineBuild(directory));
    const smaller = await manifestGenerationOf(directory);
    const switching = String.raw`rename:/\.cratepin-manifest\.json\.tmp -> `;
    await useVoiceOnly();
    const before = { label: 'before', step: `${switching}:before`, expected: smaller };
    assert.notEqual(await buildReadAt(directory, before), smaller);
    await releases.useFull();
    const after = { label: 'after', step: `${switching}:after`, expected: full };
    assert.equal(await buildReadAt(directory, after), full);
    await releases.useSmaller();
    const retiring = String.raw`unlink:/generations/\.trash/:after`;
    const during = { label: 'retiring', step: retiring, expected: smaller };
    assert.equal(await buildReadAt(directory, during), smaller);
  });
}

async function pullBesideBuildBeforeRecord() {
  await withProject({ isWarm: true }, async (directory) => {
    const derivatives = join(directory, '.cratepin-cache', 'derivatives');
    const step = String.raw`link:\.part -> .*/derivatives/[^/]*\.json$:before`;
    const building = startPaused({ directory, label: 'build', step }, ...BUILD);
    try {
      await untilReached(building);
      const names = await readdir(derivatives);
      assert.equal(names.length, 1, `only the output is there: ${names.join(', ')}`);
      assert.ok(!names[0].endsWith('.json'), 'the record is not linked yet');
      await assertCacheConsistent(directory);
      assertSucceeded(await pull(directory));
      await assertCacheConsistent(directory);
      assertSucceeded(await release(building));
      assert.equal((await readdir(derivatives)).length, 2, 'the output and its record');
      await assertCacheConsistent(directory);
    } finally {
      await stopRuns(building);
    }
  });
}

const OTHER_CONFIG = 'other.config.json';

/**
 * A second config publishing into the same output root with a cache and lock of its own (the
 * smaller release); the default config keeps the full one. Its cache is filled.
 */
async function writeOtherConfig(directory, releases) {
  await releases.useSmaller();
  await writeFile(
    join(directory, 'other-lock.json'),
    await readFile(join(directory, 'cratepin-lock.json')),
  );
  await releases.useFull();
  const config = JSON.parse(await readFile(join(directory, DEFAULT_CONFIG_FILE), 'utf8'));
  const other = { ...config, cacheDir: '.other-cache', lockFile: 'other-lock.json' };
  await writeFile(join(directory, OTHER_CONFIG), JSON.stringify(other));
  assertSucceeded(await runCliAsync(directory, {}, 'pull', '--config', OTHER_CONFIG));
}

async function twoConfigsSharingOneOutputRoot() {
  await withProject({ isWarm: true }, async (directory) => {
    await writeSentinel(directory);
    await writeOtherConfig(directory, await twoReleases(directory));
    const otherBuild = () => runWithoutNetwork(directory, ...BUILD, '--config', OTHER_CONFIG);
    assertSucceeded(await otherBuild());
    const smaller = await treeOf(rootOf(directory));
    const staging = startPaused({ directory, label: 'build', step: STAGING_MANIFEST }, ...BUILD);
    try {
      await untilReached(staging);
      const staged = await treeOf(join(workOf(directory), 'staging'));
      const refused = await otherBuild();
      assertKeptOutByBuild(refused);
      assert.match(reportOf(refused).error.details.claimFile, /\.assets\.cratepin/u);
      assert.deepEqual(await treeOf(join(workOf(directory), 'staging')), staged, 'staging kept');
      await assertPublicConsistent(directory, { mode: PATH_PRESERVING, trees: [smaller] });
      assertSucceeded(await release(staging));
      assertSucceeded(await verify(directory));
      assertSucceeded(await otherBuild());
      await assertPublicConsistent(directory, { mode: PATH_PRESERVING, trees: [smaller] });
      assertSucceeded(await verify(directory, '--config', OTHER_CONFIG));
      await assertSentinelsKept(directory);
    } finally {
      await stopRuns(staging);
    }
  });
}

describe('build interleavings', { concurrency: true }, () => {
  test(
    'a build paused between its renames keeps another build and a prune out, and nothing recovers its swap',
    buildPausedBetweenRenames,
  );
  test(
    'a build paused while staging leaves the published output whole and verify reports an interrupted publication',
    buildPausedWhileStaging,
  );
  test(
    'two builds that claim at once both back off and leave the output as it was',
    twoBuildsClaimingAtOnce,
  );
  test(
    'a generation build paused before and after its switch and during retention: a reader process always finds a complete generation',
    generationBuildPausedAroundItsSwitch,
  );
  test(
    'a pull alongside a build paused before a derivative record never finds a record without its output',
    pullBesideBuildBeforeRecord,
  );
  test(
    'two configs sharing one output root but not a cache are kept apart by the output claim',
    twoConfigsSharingOneOutputRoot,
  );
});
