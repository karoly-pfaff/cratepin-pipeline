import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withBuildFixture } from '../building/build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../building/build-fixtures.test-support.ts';
import { buildOf, snapshotOf } from '../building/build-runs.test-support.ts';
import { pngOf, transparentArtwork } from '../media/testing/media-fixtures.test-support.ts';
import { RUNTIME_MANIFEST_NAME } from '../output/layout/output-paths.ts';
import type { ManifestEntry } from '../output/manifest/runtime-manifest.ts';
import type { ParsedManifest } from './published-manifest.ts';
import {
  issueCodesOf,
  issuesWithCode,
  rewriteManifest,
  verifyFixture,
} from './verify-fixtures.test-support.ts';

function configOf(outputMode: string, isWebp: boolean): object {
  return {
    outputMode,
    profiles: {
      screen: {
        kind: 'image',
        ...(isWebp
          ? { webp: { lossless: true, keepSmaller: false } }
          : { resize: { width: 2, height: 2, fit: 'inside' } }),
      },
    },
  };
}

async function originalsOf(source = 'image.png'): Promise<FixtureOriginal[]> {
  return [{ id: 'image', source, bytes: await pngOf(transparentArtwork(2, 2)), profile: 'screen' }];
}

function withWrongSize(manifest: ParsedManifest): ParsedManifest {
  const entries = manifest.entries.map(({ id, asset }) => ({
    id,
    asset: { ...asset, width: 999, height: 777 },
  }));
  return { ...manifest, entries };
}

function sizesOf(entry: ManifestEntry): readonly (number | undefined)[] {
  return [entry.asset.width, entry.asset.height];
}

async function assertWrongSizeRefused(fixture: BuildFixture): Promise<void> {
  assert.equal((await buildOf(fixture)).publication?.outcome, 'published');
  await rm(fixture.project.paths.cacheRoot, { recursive: true });
  await rewriteManifest(fixture, (manifest) => {
    assert.deepEqual(manifest.entries.map(sizesOf), [[2, 2]]);
    return manifest;
  });
  const fresh = await snapshotOf(fixture.workspace);
  assert.deepEqual((await verifyFixture(fixture)).issues, []);
  assert.deepEqual(await snapshotOf(fixture.workspace), fresh);
  await rewriteManifest(fixture, withWrongSize);
  const changed = await snapshotOf(fixture.workspace);
  const verification = await verifyFixture(fixture);
  assert.deepEqual(issueCodesOf(verification), ['MANIFEST_MISMATCH']);
  assert.deepEqual(issuesWithCode(verification, 'MANIFEST_MISMATCH'), [
    'image: dimensions: the entry says 999 by 777, the published header is 2 by 2',
  ]);
  assert.deepEqual(await snapshotOf(fixture.workspace), changed);
  assert.equal(Object.keys(fresh).filter((path) => fresh[path] !== changed[path]).length, 1);
}

for (const outputMode of ['path-preserving', 'generation']) {
  for (const isWebp of [false, true]) {
    test(`${outputMode} ${isWebp ? 'WebP' : 'PNG'} checks actual header dimensions without its cache`, async () => {
      await assert.doesNotReject(
        withBuildFixture(await originalsOf(), configOf(outputMode, isWebp), assertWrongSizeRefused),
      );
    });
  }
}

const INVALID_PAIRS = [
  '"width": 0,\n      "height": 2,',
  '"width": 2,\n      "height": 0,',
  '"width": -1,\n      "height": 2,',
  '"width": 1.5,\n      "height": 2,',
  '"width": "2",\n      "height": 2,',
  '"width": null,\n      "height": 2,',
  '"width": 9007199254740992,\n      "height": 2,',
  '"width": 2,',
  '"height": 2,',
];

test('PNG image headers at long paths are verified in a generation', async () => {
  const source = `${'long-directory-name/'.repeat(16)}image.png`;
  assert.ok(source.length > 260);
  await withBuildFixture(
    await originalsOf(source),
    configOf('generation', false),
    assertWrongSizeRefused,
  );
});

test('zero, malformed and incomplete dimension pairs are invalid', async () => {
  await withBuildFixture(
    await originalsOf(),
    configOf('path-preserving', true),
    async (fixture) => {
      await buildOf(fixture);
      const file = join(fixture.project.paths.outputRoot, RUNTIME_MANIFEST_NAME);
      const canonical = await readFile(file, 'utf8');
      for (const pair of INVALID_PAIRS) {
        const edited = canonical.replace('"width": 2,\n      "height": 2,', pair);
        assert.notEqual(edited, canonical);
        await writeFile(file, edited);
        assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['MANIFEST_INVALID'], pair);
      }
    },
  );
});

const COPIED_ORIGINALS: readonly FixtureOriginal[] = [
  { source: 'copy.png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), profile: 'copy' },
  { source: 'empty.json', bytes: Buffer.alloc(0), category: 'other' as const },
];

function assertNoDimensions(manifest: ParsedManifest): ParsedManifest {
  assert.deepEqual(manifest.entries.map(sizesOf), [
    [undefined, undefined],
    [undefined, undefined],
  ]);
  return manifest;
}

test('dimension-free copies including an empty file are never decoded', async () => {
  await withBuildFixture(COPIED_ORIGINALS, {}, async (fixture) => {
    assert.equal((await buildOf(fixture)).publication?.outcome, 'published');
    await rewriteManifest(fixture, assertNoDimensions);
    assert.deepEqual((await verifyFixture(fixture)).issues, []);
  });
});

test('unreadable image headers and dimensions on non-images are blocking issues', async () => {
  await withBuildFixture(COPIED_ORIGINALS, {}, async (fixture) => {
    assert.equal((await buildOf(fixture)).publication?.outcome, 'published');
    await rewriteManifest(fixture, withWrongSize);
    assert.deepEqual(issuesWithCode(await verifyFixture(fixture), 'MANIFEST_MISMATCH'), [
      'copy: dimensions: the published image header cannot be read.',
      'empty: dimensions: only PNG or WebP entries can declare dimensions.',
    ]);
  });
});
