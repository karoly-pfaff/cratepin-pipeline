import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { claimCacheForBuild } from '../cache/cache-claims.ts';
import { claimOutputForBuild } from '../output/ownership/output-claim.ts';
import { originalPathOf } from '../cache/cache-layout.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { noiseArtwork, pngOf } from '../media/testing/media-fixtures.test-support.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import type { PipelineError } from '../errors.ts';
import {
  faultyFileSystem,
  failingNone,
} from '../output/publication/publication-fixtures.test-support.ts';
import type { FailurePlan } from '../output/publication/publication-fixtures.test-support.ts';
import { workDirectoryOf } from '../output/layout/work-directory.ts';
import { failsBecause, lockOfOriginals, withBuildFixture } from './build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from './build-fixtures.test-support.ts';
import type { BuildResult } from './build-run.ts';
import {
  BUILD_CONFIG,
  buildOf,
  buildOriginals,
  snapshotOf,
  withoutFirstAsset,
} from './build-runs.test-support.ts';

function removedFileCountOf(result: BuildResult): number {
  return result.publication === undefined ? 0 : result.publication.removedFileCount;
}

function lockedSha256(fixture: BuildFixture, index: number): string {
  const record = fixture.lock.assets[index];
  if (record === undefined) throw new Error(`No locked asset ${String(index)}`);
  return record.sha256;
}

function refusalCodesOf(result: BuildResult): string[] {
  return (result.built?.issues ?? []).map(({ code }) => code);
}

function originalStatusesOf(result: BuildResult): string[] {
  return (result.originals ?? []).map(({ status }) => status);
}

test('a first build publishes the complete output next to untouched public files', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const publicHost = join(fixture.workspace, 'public', 'index.html');
    await writeFile(publicHost, 'the host page');
    const result = await buildOf(fixture);
    assert.equal(result.publication?.outcome, 'published');
    assert.deepEqual(Object.keys(await snapshotOf(fixture.project.paths.outputRoot)), [
      '.cratepin-generation.json',
      '.cratepin-output.json',
      'app/ui/button.webp',
      'cratepin-manifest.json',
      'voice/hu/hello.mp3',
    ]);
    assert.equal(await readFile(publicHost, 'utf8'), 'the host page');
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), ['assets', 'index.html']);
  });
});

test('a second build of the same lock finds the output unchanged and touches nothing', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const before = await snapshotOf(fixture.project.paths.outputRoot);
    const { fileSystem, operations } = faultyFileSystem(failingNone());
    const again = await buildOf(fixture, { fileSystem });
    assert.equal(again.publication?.outcome, 'unchanged');
    assert.deepEqual(operations, [], 'no rename, no removal');
    assert.deepEqual(await snapshotOf(fixture.project.paths.outputRoot), before);
  });
});

test('a changed lock replaces the output and removes what no longer belongs to it', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const result = await buildOf(await withoutFirstAsset(fixture));
    assert.equal(result.publication?.outcome, 'published');
    const files = Object.keys(await snapshotOf(fixture.project.paths.outputRoot));
    assert.ok(!files.includes('app/ui/button.webp'), 'the removed asset is gone');
    assert.ok(removedFileCountOf(result) > 0);
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), ['assets'], 'no work left');
  });
});

test('an output directory the tool does not own is refused and left as it is', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const root = fixture.project.paths.outputRoot;
    await mkdir(root);
    await writeFile(join(root, 'legacy.png'), 'hand made');
    await assert.rejects(buildOf(fixture), failsBecause('OUTPUT_CONFLICT', 'OUTPUT_NOT_OWNED'));
    assert.deepEqual(await readdir(root), ['legacy.png']);
  });
});

test('an owned output holding something the tool did not write is refused, not swapped away', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const root = fixture.project.paths.outputRoot;
    await writeFile(join(root, 'notes.txt'), 'mine');
    const before = await snapshotOf(root);
    const refused = await buildOf(await withoutFirstAsset(fixture));
    assert.ok(failsBecause('OUTPUT_CONFLICT', 'UNLISTED_OUTPUT_ENTRY')(refused.failure));
    assert.equal(refused.publication, undefined);
    assert.deepEqual(await snapshotOf(root), before);
  });
});

test('a build that cannot convert an asset or find an original keeps the previous output', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const root = fixture.project.paths.outputRoot;
    const before = await snapshotOf(root);
    const bad = { source: 'app/ui/bad.png', bytes: Buffer.from('not a png'), profile: 'ui-strict' };
    const broken = { ...fixture, lock: lockOfOriginals([bad]) };
    await writeFile(originalPathOf(fixture.layout, lockedSha256(broken, 0)), bad.bytes);
    const refused = await buildOf(broken);
    assert.equal(refused.publication, undefined);
    assert.deepEqual(refusalCodesOf(refused), ['IMAGE_UNREADABLE']);
    await rm(originalPathOf(fixture.layout, lockedSha256(fixture, 1)));
    assert.deepEqual(originalStatusesOf(await buildOf(fixture)), ['cached', 'missing']);
    assert.deepEqual(await snapshotOf(root), before);
  });
});

/** A failure plan that aborts `controller` when the staging directory is created. */
function abortingOnStaging(controller: AbortController): FailurePlan {
  return ({ name, paths }) => {
    if (name === 'mkdir' && (paths[0] ?? '').endsWith('staging')) controller.abort();
    return undefined;
  };
}

test('cancelled while staging, a build removes its staging and keeps the previous output', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const root = fixture.project.paths.outputRoot;
    const before = await snapshotOf(root);
    const controller = new AbortController();
    const { fileSystem } = faultyFileSystem(abortingOnStaging(controller));
    const changed = await withoutFirstAsset(fixture);
    const cancelled = await buildOf(changed, { fileSystem, signal: controller.signal });
    assert.ok(failsBecause('CANCELLED')(cancelled.failure));
    assert.deepEqual(await snapshotOf(root), before);
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), ['assets']);
  });
});

test('a first build into an existing empty output root leaves no work directory behind', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await mkdir(fixture.project.paths.outputRoot);
    const result = await buildOf(fixture);
    assert.equal(result.publication?.outcome, 'published');
    assert.deepEqual(result.publication.notices, []);
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), ['assets']);
  });
});

/** A failure plan that puts a junction where the source directory was, once staging starts. */
function linkingSourcesOnStaging(fixture: BuildFixture): FailurePlan {
  return ({ name, paths }) => {
    if (name !== 'mkdir' || !(paths[0] ?? '').endsWith('staging')) return undefined;
    const elsewhere = join(fixture.workspace, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    rmSync(fixture.project.paths.sourceRoot, { recursive: true, force: true });
    mkdirSync(dirname(fixture.project.paths.sourceRoot), { recursive: true });
    symlinkSync(elsewhere, fixture.project.paths.sourceRoot, 'junction');
    return undefined;
  };
}

test('a layout that changes while staging stops the build before the swap', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const root = fixture.project.paths.outputRoot;
    const before = await snapshotOf(root);
    const { fileSystem } = faultyFileSystem(linkingSourcesOnStaging(fixture));
    const result = await buildOf(await withoutFirstAsset(fixture), { fileSystem });
    assert.match(result.failure?.message ?? '', /layout changed; nothing was published/u);
    assert.deepEqual(await snapshotOf(root), before);
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), ['assets']);
  });
});

test('a build stopped after recovery still reports what recovery did', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const work = workDirectoryOf(fixture.project.paths.outputRoot);
    await mkdir(work.directory);
    await rename(work.root, work.backup);
    await writeFile(join(fixture.workspace, 'public', 'assets-notes.txt'), 'unrelated');
    const controller = new AbortController();
    controller.abort();
    const result = await buildOf(fixture, { signal: controller.signal });
    assert.equal(result.recovery?.outcome, 'rolled-back');
    assert.ok(failsBecause('CANCELLED')(result.failure));
    assert.equal(
      await readFile(join(fixture.workspace, 'public', 'assets-notes.txt'), 'utf8'),
      'unrelated',
    );
  });
});

/** Matches the conflict of a build kept out by the claim in `claimFile`. */
function keptOutBy(claimFile: string): (error: unknown) => boolean {
  return (error) =>
    failsBecause('OUTPUT_CONFLICT')(error) &&
    (error as PipelineError).details.claimFile === claimFile;
}

test('while another build holds its claim, a build is kept out before it touches anything', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const before = await snapshotOf(fixture.project.paths.outputRoot);
    const other = await claimCacheForBuild(fixture.layout, 'build');
    try {
      await assert.rejects(buildOf(await withoutFirstAsset(fixture)), keptOutBy(other.file));
    } finally {
      await other.release();
    }
    assert.deepEqual(await snapshotOf(fixture.project.paths.outputRoot), before);
  });
});

test('a build of another config publishing into the same root keeps this one out, whatever its cache', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const before = await snapshotOf(fixture.project.paths.outputRoot);
    const otherConfig = await claimOutputForBuild(fixture.project.paths.outputRoot);
    try {
      await assert.rejects(buildOf(await withoutFirstAsset(fixture)), keptOutBy(otherConfig.file));
    } finally {
      await otherConfig.release();
    }
    assert.deepEqual(await snapshotOf(fixture.project.paths.outputRoot), before);
    assert.equal(
      (await buildOf(await withoutFirstAsset(fixture))).publication?.outcome,
      'published',
    );
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), ['assets'], 'no claim left');
  });
});

const CREDENTIAL_NAMED: FixtureOriginal = {
  source: 'voice/hu/AKIAABCDEFGHIJKLMNOP.mp3',
  bytes: Buffer.from('ID3 key-shaped name'),
  category: 'voice',
  locale: 'hu',
};

test('a build that would publish a value that must not ship publishes nothing', async () => {
  const originals = [...(await buildOriginals()), CREDENTIAL_NAMED];
  await withBuildFixture(originals, BUILD_CONFIG, async (fixture) => {
    const safe = { ...fixture, lock: lockOfOriginals(originals.slice(0, 2)) };
    await buildOf(safe);
    const before = await snapshotOf(fixture.project.paths.outputRoot);
    const refused = await buildOf(fixture);
    assert.ok(failsBecause('INVALID_DATA', 'MANIFEST_UNSAFE_VALUE')(refused.failure));
    assert.equal(refused.publication, undefined);
    assert.deepEqual(await snapshotOf(fixture.project.paths.outputRoot), before);
  });
});

/** Twenty originals whose lossless WebP conversion takes long enough to be interrupted. */
async function slowOriginals(): Promise<FixtureOriginal[]> {
  const originals: FixtureOriginal[] = [];
  for (let index = 0; index < 20; index += 1) {
    const bytes = await pngOf(noiseArtwork(192 + index, 192));
    originals.push({ source: `app/ui/noise-${String(index)}.png`, bytes, profile: 'ui-strict' });
  }
  return originals;
}

/** A derivative's record, written once its output is in the cache. */
function isDerivativeRecord(name: string): boolean {
  return name.endsWith('.json');
}

function isPartFile(name: string): boolean {
  return name.endsWith('.part');
}

async function abortIfAnyDerivative(
  layout: CacheLayout,
  controller: AbortController,
): Promise<void> {
  const names = await readdir(layout.derivatives, { recursive: true });
  if (names.some(isDerivativeRecord)) controller.abort();
}

/** Aborts `controller` as soon as the first derivative is in the cache. */
function abortOnFirstDerivative(layout: CacheLayout, controller: AbortController): NodeJS.Timeout {
  return setInterval(() => void abortIfAnyDerivative(layout, controller), 2);
}

/** A build of `fixture` that is cancelled once its first conversion is done. */
async function buildCancelledAfterFirstConversion(fixture: BuildFixture): Promise<BuildResult> {
  const controller = new AbortController();
  const timer = abortOnFirstDerivative(fixture.layout, controller);
  try {
    return await buildOf(fixture, { signal: controller.signal, concurrency: 8 });
  } finally {
    clearInterval(timer);
  }
}

test('cancelled during conversions, a build starts no waiting conversion and leaves no part file', async () => {
  await withBuildFixture(await slowOriginals(), BUILD_CONFIG, async (fixture) => {
    const cancelled = await buildCancelledAfterFirstConversion(fixture);
    assert.ok(failsBecause('CANCELLED')(cancelled.failure));
    // Eight assets were in progress but two convert at once: those waiting never start.
    const derivatives = await readdir(fixture.layout.derivatives, { recursive: true });
    const records = derivatives.filter(isDerivativeRecord);
    assert.ok(records.length <= 4, `${String(records.length)} conversions finished in all`);
    assert.equal(await entryKindAt(fixture.project.paths.outputRoot), 'absent');
    const cacheNames = await readdir(fixture.project.paths.cacheRoot, { recursive: true });
    assert.deepEqual(cacheNames.filter(isPartFile), []);
    assert.deepEqual(await readdir(fixture.layout.claims), []);
    const rebuilt = await buildOf(fixture);
    assert.equal(rebuilt.failure, undefined);
    assert.equal(rebuilt.publication?.outcome, 'published');
  });
});
