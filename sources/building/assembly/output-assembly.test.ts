import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { mediaTypeOf } from '../../catalog/media-types.ts';
import { sha256Of } from '../../catalog/source-fixtures.test-support.ts';
import type { ManifestAsset, RuntimeManifest } from '../../contracts.ts';
import { encoderFingerprint } from '../../media/encoding/encoder-fingerprint.ts';
import {
  gradientBackgroundPng,
  paletteNoisePng,
  pngOf,
  transparentArtwork,
} from '../../media/testing/media-fixtures.test-support.ts';
import {
  GENERATION_LISTING_NAME,
  generationNameOf,
} from '../../output/generation/generation-listing.ts';
import { RUNTIME_MANIFEST_NAME } from '../../output/layout/output-paths.ts';
import { auditOutputTree } from '../../output/files/tree-audit.ts';
import { buildAssetOutputs, imageGateFor } from './asset-outputs.ts';
import type { BuiltAssets } from './asset-outputs.ts';
import type { SourceRecord } from '../../lock/source-lock.ts';
import { lockOfOriginals, withBuildFixture } from '../build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../build-fixtures.test-support.ts';
import { planBuild } from '../planning/build-plan.ts';
import { assembleOutput } from './output-assembly.ts';
import type { AssembledOutput } from './output-assembly.ts';
import { stageOutputTree } from './staged-tree.ts';

const LOSSY = { lossless: false, quality: 80, alphaQuality: 100, keepSmaller: true };

const CONFIG = {
  profiles: {
    'actor-box': { kind: 'image', resize: { width: 16, height: 16, fit: 'contain' } },
    artwork: { kind: 'image', webp: { lossless: true } },
    background: { kind: 'image', webp: LOSSY },
    'ui-strict': { kind: 'image', webp: { lossless: true, keepSmaller: false } },
  },
};

async function mixedMedia(): Promise<FixtureOriginal[]> {
  const voice = (text: string): Uint8Array => Buffer.from(`ID3 ${text} voice line`);
  return [
    {
      source: 'app/images/actor.png',
      bytes: await pngOf(transparentArtwork(7, 5)),
      profile: 'actor-box',
      role: 'actor',
    },
    {
      source: 'app/images/art.png',
      bytes: await pngOf(transparentArtwork(32, 24)),
      profile: 'artwork',
    },
    { source: 'app/images/noise.png', bytes: await paletteNoisePng(), profile: 'background' },
    {
      source: 'app/ui/button.png',
      bytes: await pngOf(transparentArtwork(9, 9)),
      profile: 'ui-strict',
    },
    { source: 'scenes/forest/bg.png', bytes: await gradientBackgroundPng(), profile: 'background' },
    { source: 'voice/hu/hello.mp3', bytes: voice('hu'), category: 'voice', locale: 'hu' },
    { source: 'voice/en/hello.mp3', bytes: voice('en'), category: 'voice', locale: 'en' },
    { source: 'app/logo.svg', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    { source: 'data/levels.json', bytes: Buffer.from('{"levels":[1,2]}'), category: 'other' },
    {
      source: 'print/page.png',
      bytes: await gradientBackgroundPng(),
      id: 'print.page',
      role: 'print-master',
    },
  ];
}

async function builtFor(fixture: BuildFixture, concurrency = 4): Promise<BuiltAssets> {
  const plan = planBuild(fixture.project.config, fixture.lock);
  assert.deepEqual(plan.issues, []);
  return buildAssetOutputs({
    layout: fixture.layout,
    assets: plan.assets,
    fingerprint: encoderFingerprint(),
    maxImagePixels: fixture.project.config.limits.maxImagePixels,
    concurrency,
    imageGate: imageGateFor(2, concurrency),
  });
}

/** Stages the assembled output into a new directory and returns that directory. */
async function stagedTreeOf(
  fixture: BuildFixture,
  built: BuiltAssets,
  assembled: AssembledOutput,
): Promise<string> {
  const directory = join(fixture.workspace, 'staging');
  await mkdir(directory);
  await stageOutputTree({
    directory,
    built: built.built,
    toolFiles: [
      { name: GENERATION_LISTING_NAME, text: assembled.listingText },
      { name: RUNTIME_MANIFEST_NAME, text: assembled.manifestText },
    ],
  });
  return directory;
}

function recordsById({ lock }: BuildFixture): Map<string, SourceRecord> {
  return new Map(lock.assets.map((record) => [record.id, record]));
}

/** Looks a manifest entry up by ID, failing the test when there is none. */
function entryFinder(assembled: AssembledOutput): (id: string) => ManifestAsset {
  const assets = new Map(assetsOf(assembled));
  return (id) => {
    const asset = assets.get(id);
    if (asset === undefined) throw new Error(`No manifest entry for ${id}`);
    return asset;
  };
}

function assetsOf(assembled: AssembledOutput): [string, ManifestAsset][] {
  return Object.entries((JSON.parse(assembled.manifestText) as RuntimeManifest).assets);
}

test('a mixed-media build stages a complete tree whose manifest matches every byte', async () => {
  await withBuildFixture(await mixedMedia(), CONFIG, async (fixture) => {
    const built = await builtFor(fixture);
    assert.deepEqual(built.issues, []);
    const assembled = assembleOutput(fixture.project.config, built.built);
    const directory = await stagedTreeOf(fixture, built, assembled);
    const toolFiles = [
      { name: GENERATION_LISTING_NAME, text: assembled.listingText },
      { name: RUNTIME_MANIFEST_NAME, text: assembled.manifestText },
    ];
    assert.deepEqual(await auditOutputTree(directory, { files: assembled.files, toolFiles }), []);
    const assets = assetsOf(assembled);
    assert.equal(assets.length, fixture.lock.assets.length, 'every locked asset, print master too');
    for (const [id, asset] of assets) {
      const path = asset.url.slice('assets/'.length);
      const bytes = await readFile(join(directory, ...path.split('/')));
      assert.deepEqual([sha256Of(bytes), bytes.length], [asset.sha256, asset.bytes], id);
      assert.equal(mediaTypeOf(path), asset.mediaType, id);
      const record = recordsById(fixture).get(id);
      assert.deepEqual([asset.source, asset.sourceSha256], [record?.source, record?.sha256], id);
    }
  });
});

test('copies keep their bytes and metadata; converted images carry their dimensions', async () => {
  await withBuildFixture(await mixedMedia(), CONFIG, async (fixture) => {
    const assembled = assembleOutput(fixture.project.config, (await builtFor(fixture)).built);
    const entry = entryFinder(assembled);
    const print = entry('print.page');
    for (const id of [
      'voice/hu/hello',
      'voice/en/hello',
      'app/logo',
      'data/levels',
      'print.page',
    ]) {
      const copied = entry(id);
      const record = recordsById(fixture).get(id);
      assert.deepEqual(
        [copied.sha256, copied.bytes],
        [record?.sha256, record?.bytes],
        `${id} is a byte copy`,
      );
    }
    assert.equal(print.role, 'print-master');
    assert.deepEqual(
      [entry('voice/hu/hello').locale, entry('voice/en/hello').locale],
      ['hu', 'en'],
    );
    assert.equal(entry('voice/hu/hello').width, undefined, 'a copy is never decoded');
    const actor = entry('app/images/actor');
    assert.deepEqual([actor.width, actor.height], [16, 16]);
    assert.equal(entry('app/ui/button').url, 'assets/app/ui/button.webp');
    assert.equal(entry('app/images/noise').url, 'assets/app/images/noise.png', 'kept smaller');
    assert.equal(entry('app/logo').mediaType, 'image/svg+xml');
  });
});

test('the manifest holds no absolute, cache or remote path', async () => {
  await withBuildFixture(await mixedMedia(), CONFIG, async (fixture) => {
    const assembled = assembleOutput(fixture.project.config, (await builtFor(fixture)).built);
    for (const forbidden of [fixture.workspace, fixture.layout.root, 'https://', 'X-Amz', ':\\']) {
      assert.ok(!assembled.manifestText.includes(forbidden), forbidden);
    }
    for (const [, asset] of assetsOf(assembled))
      assert.doesNotMatch(asset.url, /(?:^\/)|(?:\.\.)/u);
  });
});

test('the same lock gives the same manifest and generation in any order and concurrency', async () => {
  const originals = await mixedMedia();
  await withBuildFixture(originals, CONFIG, async (fixture) => {
    const first = assembleOutput(fixture.project.config, (await builtFor(fixture, 8)).built);
    const shuffled = { ...fixture, lock: lockOfOriginals(originals.toReversed()) };
    const second = assembleOutput(fixture.project.config, (await builtFor(shuffled, 1)).built);
    assert.equal(second.manifestText, first.manifestText);
    assert.equal(second.listingText, first.listingText);
    assert.equal(second.generation, first.generation);
  });
});

test('generation mode puts every URL inside the generation; the generation is the same', async () => {
  const originals = await mixedMedia();
  let pathPreserving = '';
  await withBuildFixture(originals, CONFIG, async (fixture) => {
    pathPreserving = assembleOutput(
      fixture.project.config,
      (await builtFor(fixture)).built,
    ).generation;
  });
  await withBuildFixture(originals, { ...CONFIG, outputMode: 'generation' }, async (fixture) => {
    const assembled = assembleOutput(fixture.project.config, (await builtFor(fixture)).built);
    assert.equal(assembled.generation, pathPreserving, 'the listing does not depend on the mode');
    const prefix = `assets/generations/${generationNameOf(assembled.generation)}/`;
    for (const [id, asset] of assetsOf(assembled)) assert.ok(asset.url.startsWith(prefix), id);
  });
});
