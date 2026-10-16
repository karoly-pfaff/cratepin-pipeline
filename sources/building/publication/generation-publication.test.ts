import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { generationLayoutOf } from '../../output/generation/generation-layout.ts';
import type { GenerationLayout } from '../../output/generation/generation-layout.ts';
import { generationNameOf } from '../../output/generation/generation-listing.ts';
import { OUTPUT_MARKER_NAME, outputMarkerTextOf } from '../../output/ownership/output-marker.ts';
import { workDirectoryOf } from '../../output/layout/work-directory.ts';
import { linkDirectory } from '../../paths/layout/layout-fixtures.test-support.ts';
import {
  blockingRenamesFrom,
  faultyFileSystem,
  failingNone,
  writeListedTree,
} from '../../output/publication/publication-fixtures.test-support.ts';
import type { FailurePlan } from '../../output/publication/publication-fixtures.test-support.ts';
import { failsBecause, lockOfOriginals, withBuildFixture } from '../build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../build-fixtures.test-support.ts';
import type { BuildResult } from '../build-run.ts';
import {
  buildOf,
  buildOriginals,
  GENERATION_CONFIG,
  sameTree,
  snapshotOf,
} from '../build-runs.test-support.ts';

/** Three cached originals: an image, a voice line and another voice line. */
async function threeOriginals(): Promise<FixtureOriginal[]> {
  const [image, voice] = (await buildOriginals()) as [FixtureOriginal, FixtureOriginal];
  return [image, voice, { ...voice, source: 'voice/hu/bye.mp3', bytes: Buffer.from('ID3 bye') }];
}

/** Three releases of the lock: the image and a voice line, only that voice line, only the other. */
async function releasesOf(fixture: BuildFixture): Promise<BuildFixture[]> {
  const [image, voice, bye] = (await threeOriginals()) as [
    FixtureOriginal,
    FixtureOriginal,
    FixtureOriginal,
  ];
  return [[image, voice], [voice], [bye]].map((originals) => ({
    ...fixture,
    lock: lockOfOriginals(originals),
  }));
}

function removedFileCountOf(result: BuildResult): number {
  return result.publication === undefined ? 0 : result.publication.removedFileCount;
}

function noticeCodesOfResult(result: BuildResult): string[] {
  return (result.publication?.notices ?? []).map(({ code }) => code);
}

function noticeCodesOfRecovery(result: BuildResult): string[] {
  return (result.recovery?.notices ?? []).map(({ code }) => code);
}

function layoutOf(fixture: BuildFixture): GenerationLayout {
  return generationLayoutOf(fixture.project.paths.outputRoot);
}

async function manifestOf(fixture: BuildFixture): Promise<{ generation: string; assets: object }> {
  return JSON.parse(await readFile(layoutOf(fixture).manifest, 'utf8')) as {
    generation: string;
    assets: object;
  };
}

async function generationNamesOf(fixture: BuildFixture): Promise<string[]> {
  return (await readdir(layoutOf(fixture).generations)).toSorted(compareCodeUnits);
}

function generationOf(result: BuildResult): string {
  const generation = result.assembled?.generation;
  if (generation === undefined) throw new Error('The build assembled no output');
  return generation;
}

function nameOf(result: BuildResult): string {
  return generationNameOf(generationOf(result));
}

test('a first build creates the root, its generation and the manifest naming it', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    await writeFile(join(fixture.workspace, 'public', 'index.html'), 'the host page');
    const result = await buildOf(fixture);
    assert.equal(result.publication?.outcome, 'published');
    const name = nameOf(result);
    assert.deepEqual(await generationNamesOf(fixture), [name]);
    assert.deepEqual(Object.keys(await snapshotOf(join(layoutOf(fixture).generations, name))), [
      '.cratepin-generation.json',
      'app/ui/button.webp',
      'voice/hu/bye.mp3',
      'voice/hu/hello.mp3',
    ]);
    const manifest = await manifestOf(fixture);
    assert.equal(manifest.generation, generationOf(result));
    assert.match(
      JSON.stringify(manifest.assets),
      new RegExp(`assets/generations/${name}/voice/hu/hello\\.mp3`, 'u'),
    );
    assert.deepEqual((await readdir(fixture.project.paths.outputRoot)).toSorted(compareCodeUnits), [
      '.cratepin-output.json',
      'cratepin-manifest.json',
      'generations',
    ]);
    assert.equal(
      await readFile(join(fixture.workspace, 'public', 'index.html'), 'utf8'),
      'the host page',
    );
  });
});

test('the same lock again is unchanged and touches nothing', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const before = await snapshotOf(fixture.project.paths.outputRoot);
    const { fileSystem, operations } = faultyFileSystem(failingNone());
    assert.equal((await buildOf(fixture, { fileSystem })).publication?.outcome, 'unchanged');
    assert.deepEqual(operations, []);
    assert.deepEqual(await snapshotOf(fixture.project.paths.outputRoot), before);
  });
});

test('the new and the previous generation are kept, an older one is retired', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const results: BuildResult[] = [];
    for (const release of await releasesOf(fixture)) results.push(await buildOf(release));
    const [oldest, previous, newest] = results as [BuildResult, BuildResult, BuildResult];
    assert.deepEqual(
      await generationNamesOf(fixture),
      [nameOf(previous), nameOf(newest)].toSorted(compareCodeUnits),
    );
    assert.equal(newest.publication?.previousGeneration, generationOf(previous));
    assert.ok(removedFileCountOf(newest) >= 3, 'the oldest generation was removed');
    assert.ok(!(await generationNamesOf(fixture)).includes(nameOf(oldest)));
  });
});

test('going back to the previous generation reuses it and switches the manifest back', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second] = (await releasesOf(fixture)) as [BuildFixture, BuildFixture];
    const original = await buildOf(first);
    await buildOf(second);
    const generationDirectory = join(layoutOf(fixture).generations, nameOf(original));
    const before = await snapshotOf(generationDirectory);
    const back = await buildOf(first);
    assert.equal(back.publication?.outcome, 'published');
    assert.equal((await manifestOf(fixture)).generation, generationOf(original));
    assert.deepEqual(await snapshotOf(generationDirectory), before, 'reused, not rewritten');
  });
});

test('a manifest held open keeps the old one; the placed generation is reused next time', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second] = (await releasesOf(fixture)) as [BuildFixture, BuildFixture];
    await buildOf(first);
    const oldManifest = await readFile(layoutOf(fixture).manifest, 'utf8');
    const { fileSystem } = faultyFileSystem(blockingRenamesFrom('.cratepin-manifest.json.tmp'));
    const blocked = await buildOf(second, { fileSystem });
    assert.ok(failsBecause('OUTPUT_CONFLICT', 'OUTPUT_IN_USE')(blocked.failure));
    assert.equal(await readFile(layoutOf(fixture).manifest, 'utf8'), oldManifest);
    assert.ok(
      !(await readdir(fixture.project.paths.outputRoot)).includes('.cratepin-manifest.json.tmp'),
    );
    assert.equal((await buildOf(second)).publication?.outcome, 'published');
  });
});

test('a changed file in the published generation is refused, never rewritten in place', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const result = await buildOf(fixture);
    const voice = join(layoutOf(fixture).generations, nameOf(result), 'voice', 'hu', 'hello.mp3');
    await writeFile(voice, 'edited');
    const again = await buildOf(fixture);
    assert.ok(failsBecause('OUTPUT_CONFLICT', 'GENERATION_DAMAGED')(again.failure));
    assert.equal(await readFile(voice, 'utf8'), 'edited');
  });
});

test('another digest under the published short name is a collision, never replaced', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const result = await buildOf(fixture);
    const generation = generationOf(result);
    const layout = layoutOf(fixture);
    const manifest = await readFile(layout.manifest, 'utf8');
    const otherDigest =
      generation.slice(0, 16) + (generation[16] === '0' ? '1' : '0') + generation.slice(17);
    await writeFile(layout.manifest, manifest.replace(generation, otherDigest));
    await writeFile(join(layout.generations, nameOf(result), 'voice', 'hu', 'hello.mp3'), 'other');
    const again = await buildOf(fixture);
    assert.ok(failsBecause('OUTPUT_CONFLICT', 'GENERATION_COLLISION')(again.failure));
  });
});

test('a damaged generation that is not published is moved away and built fresh', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second] = (await releasesOf(fixture)) as [BuildFixture, BuildFixture];
    const original = await buildOf(first);
    await buildOf(second);
    const directory = join(layoutOf(fixture).generations, nameOf(original));
    const intact = await snapshotOf(directory);
    await writeFile(join(directory, 'voice', 'hu', 'hello.mp3'), 'edited');
    assert.equal((await buildOf(first)).publication?.outcome, 'published');
    assert.ok(sameTree(await snapshotOf(directory), intact));
  });
});

test('entries the tool did not write are kept and reported, wherever they are', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    await buildOf(fixture);
    const layout = layoutOf(fixture);
    await writeFile(join(layout.root, 'notes.txt'), 'mine');
    await mkdir(join(layout.generations, 'stray'));
    const [, second] = (await releasesOf(fixture)) as [BuildFixture, BuildFixture];
    const result = await buildOf(second);
    const codes = noticeCodesOfResult(result);
    assert.deepEqual(codes, ['UNKNOWN_OUTPUT_NAME', 'UNKNOWN_OUTPUT_NAME']);
    assert.equal(await readFile(join(layout.root, 'notes.txt'), 'utf8'), 'mine');
    assert.ok((await readdir(layout.generations)).includes('stray'));
  });
});

test('a root marked for this project but full of other files gets nothing of them removed', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const layout = layoutOf(fixture);
    await buildOf(fixture);
    await mkdir(join(layout.root, 'data'));
    await writeFile(join(layout.root, 'data', 'scene.json'), '{}');
    const fakeGeneration = join(layout.generations, 'abcdefabcdefabcd');
    await mkdir(fakeGeneration);
    await writeFile(join(fakeGeneration, 'keep.txt'), 'not listed');
    const [, second, third] = (await releasesOf(fixture)) as [
      BuildFixture,
      BuildFixture,
      BuildFixture,
    ];
    await buildOf(second);
    const last = await buildOf(third);
    assert.equal(await readFile(join(layout.root, 'data', 'scene.json'), 'utf8'), '{}');
    assert.equal(await readFile(join(fakeGeneration, 'keep.txt'), 'utf8'), 'not listed');
    assert.deepEqual(noticeCodesOfResult(last), ['UNKNOWN_OUTPUT_NAME', 'UNKNOWN_OUTPUT_NAME']);
  });
});

test('a link where generations or an old generation belongs is never followed', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const layout = layoutOf(fixture);
    const sentinel = join(fixture.workspace, 'sentinel');
    await mkdir(sentinel);
    await writeFile(join(sentinel, 'keep.txt'), 'keep');
    await mkdir(layout.root);
    await writeFile(
      join(layout.root, OUTPUT_MARKER_NAME),
      outputMarkerTextOf(fixture.project.config),
    );
    await linkDirectory(sentinel, layout.generations);
    const refused = await buildOf(fixture);
    assert.ok(failsBecause('OUTPUT_CONFLICT', 'OUTPUT_NOT_A_DIRECTORY')(refused.failure));
    assert.deepEqual(await readdir(sentinel), ['keep.txt']);
  });
});

/** A directory outside the output holding `keep.txt`, which no build may touch. */
async function sentinelIn(fixture: BuildFixture): Promise<string> {
  const sentinel = join(fixture.workspace, 'sentinel');
  await mkdir(sentinel);
  await writeFile(join(sentinel, 'keep.txt'), 'keep');
  return sentinel;
}

test('a link posing as an old generation is reported and its target is untouched', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second, third] = (await releasesOf(fixture)) as [
      BuildFixture,
      BuildFixture,
      BuildFixture,
    ];
    const sentinel = await sentinelIn(fixture);
    await buildOf(first);
    await linkDirectory(sentinel, join(layoutOf(fixture).generations, '0123456789abcdef'));
    await buildOf(second);
    const last = await buildOf(third);
    assert.deepEqual(noticeCodesOfResult(last), ['UNKNOWN_OUTPUT_NAME']);
    assert.deepEqual(await readdir(sentinel), ['keep.txt']);
  });
});

test('a link where the trash belongs keeps old generations whole and its target untouched', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second, third] = (await releasesOf(fixture)) as [
      BuildFixture,
      BuildFixture,
      BuildFixture,
    ];
    const sentinel = await sentinelIn(fixture);
    const oldest = await buildOf(first);
    await buildOf(second);
    await linkDirectory(sentinel, layoutOf(fixture).trash);
    const last = await buildOf(third);
    assert.deepEqual(noticeCodesOfResult(last), ['GENERATION_KEPT', 'UNKNOWN_OUTPUT_NAME']);
    assert.ok((await generationNamesOf(fixture)).includes(nameOf(oldest)));
    assert.deepEqual(await readdir(sentinel), ['keep.txt']);
  });
});

/** A failure plan that aborts `controller` when the staging directory is created. */
function abortingOnStaging(controller: AbortController): FailurePlan {
  return ({ name, paths }) => {
    if (name === 'mkdir' && (paths[0] ?? '').endsWith('.staging')) controller.abort();
    return undefined;
  };
}

test('cancelled while staging, a build publishes nothing and leaves no staging', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second] = (await releasesOf(fixture)) as [BuildFixture, BuildFixture];
    await buildOf(first);
    const before = await snapshotOf(fixture.project.paths.outputRoot);
    const controller = new AbortController();
    const { fileSystem } = faultyFileSystem(abortingOnStaging(controller));
    const cancelled = await buildOf(second, { fileSystem, signal: controller.signal });
    assert.ok(failsBecause('CANCELLED')(cancelled.failure));
    assert.deepEqual(await snapshotOf(fixture.project.paths.outputRoot), before);
  });
});

test('an existing empty output directory is adopted with the marker', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    await mkdir(fixture.project.paths.outputRoot);
    assert.equal((await buildOf(fixture)).publication?.outcome, 'published');
    const marker = await readFile(join(layoutOf(fixture).root, OUTPUT_MARKER_NAME), 'utf8');
    assert.equal(marker, outputMarkerTextOf(fixture.project.config));
  });
});

/** Reads the manifest over and over until `isDone`; every text it saw. */
async function readManifestUntil(
  layout: GenerationLayout,
  switching: { readonly isDone: boolean },
): Promise<string[]> {
  const seen: string[] = [];
  while (!switching.isDone) {
    seen.push(await readFile(layout.manifest, 'utf8'));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return seen;
}

test('a reader of the manifest sees the old one or the new one, never anything else', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const releases = await releasesOf(fixture);
    const texts = new Set<string>();
    for (const release of releases) {
      await buildOf(release);
      texts.add(await readFile(layoutOf(fixture).manifest, 'utf8'));
    }
    const switching = { isDone: false };
    const reading = readManifestUntil(layoutOf(fixture), switching);
    for (const release of [...releases, ...releases]) await buildOf(release);
    switching.isDone = true;
    const seen = await reading;
    assert.ok(seen.length > 0);
    assert.deepEqual(new Set([...seen, ...texts]), texts, 'only complete published manifests');
  });
});

test('a link where the staging belongs is never written through or removed', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second] = (await releasesOf(fixture)) as [BuildFixture, BuildFixture];
    await buildOf(first);
    const sentinel = await sentinelIn(fixture);
    await linkDirectory(sentinel, layoutOf(fixture).staging);
    const result = await buildOf(second);
    assert.notEqual(result.failure, undefined);
    assert.ok(noticeCodesOfRecovery(result).includes('OUTPUT_TRASH_KEPT'));
    assert.deepEqual(await readdir(sentinel), ['keep.txt']);
  });
});

test('a damaged or foreign root manifest is never replaced', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const [first, second] = (await releasesOf(fixture)) as [BuildFixture, BuildFixture];
    await buildOf(first);
    const layout = layoutOf(fixture);
    const before = await generationNamesOf(fixture);
    const validGeneration = JSON.stringify({ generation: 'a'.repeat(64), assets: 'not assets' });
    const published = await readFile(layout.manifest, 'utf8');
    const otherProject = published.replace('"projectId": "demo"', '"projectId": "other"');
    assert.notEqual(otherProject, published, 'a well-formed manifest of another project');
    for (const manifest of ['{', '{"name":"another tool"}', validGeneration, otherProject]) {
      await writeFile(layout.manifest, manifest);
      const refused = await buildOf(second);
      assert.ok(failsBecause('OUTPUT_CONFLICT', 'OUTPUT_MANIFEST_INVALID')(refused.failure));
      assert.equal(await readFile(layout.manifest, 'utf8'), manifest);
      assert.deepEqual(await generationNamesOf(fixture), before);
    }
    await rm(layout.manifest);
    await mkdir(layout.manifest);
    const refused = await buildOf(second);
    assert.ok(failsBecause('OUTPUT_CONFLICT', 'OUTPUT_MANIFEST_INVALID')(refused.failure));
  });
});

/** A root marked by `marker`, holding a half staging file and a listed tree in the trash. */
async function writeMarkedRootWithLeftovers(
  layout: GenerationLayout,
  marker: string,
): Promise<void> {
  await mkdir(join(layout.staging, 'app'), { recursive: true });
  await writeFile(join(layout.root, OUTPUT_MARKER_NAME), marker);
  await writeFile(join(layout.staging, 'app', 'half.png'), 'half');
  await writeListedTree(join(layout.trash, 'old'), { 'a.txt': 'a' });
}

test('a root of another project or mode is refused and none of its files is removed', async () => {
  const markers = [
    outputMarkerTextOf({ projectId: 'other', outputMode: 'generation' }),
    outputMarkerTextOf({ projectId: 'demo', outputMode: 'path-preserving' }),
  ];
  for (const [index, marker] of markers.entries()) {
    await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
      const layout = layoutOf(fixture);
      await writeMarkedRootWithLeftovers(layout, marker);
      const before = await snapshotOf(layout.root);
      const reason = index === 0 ? 'OUTPUT_FOREIGN_PROJECT' : 'OUTPUT_MODE_CHANGED';
      await assert.rejects(buildOf(fixture), failsBecause('OUTPUT_CONFLICT', reason));
      assert.deepEqual(await snapshotOf(layout.root), before);
    });
  }
});

test('a path-preserving build’s work next to the root stops a generation build until it is gone', async () => {
  await withBuildFixture(await threeOriginals(), GENERATION_CONFIG, async (fixture) => {
    const work = workDirectoryOf(fixture.project.paths.outputRoot);
    await writeListedTree(work.staging, { 'a.txt': 'a' });
    const before = await snapshotOf(work.directory);
    const refusal = failsBecause('OUTPUT_CONFLICT', 'PATH_PRESERVING_WORK_LEFT');
    await assert.rejects(buildOf(fixture), refusal);
    assert.deepEqual(await snapshotOf(work.directory), before, 'nothing in it was touched');
    await rm(work.directory, { recursive: true });
    assert.equal((await buildOf(fixture)).publication?.outcome, 'published');
  });
});
