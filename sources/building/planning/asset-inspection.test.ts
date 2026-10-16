import assert from 'node:assert/strict';
import test from 'node:test';

import { encoderFingerprint } from '../../media/encoding/encoder-fingerprint.ts';
import {
  paletteNoisePng,
  pngOf,
  transparentArtwork,
} from '../../media/testing/media-fixtures.test-support.ts';
import { inspectAssetOutput, knownOutputsOf, refusalsOf } from './asset-inspection.ts';
import type { AssetInspection } from './asset-inspection.ts';
import { imageGateFor } from '../assembly/asset-outputs.ts';
import type { AssetBuilding } from '../assembly/asset-outputs.ts';
import {
  buildAllOutputs,
  FAILURE_PROFILES,
  issueSummaries,
  withBuildFixture,
} from '../build-fixtures.test-support.ts';
import type { BuildFixture } from '../build-fixtures.test-support.ts';
import { planBuild } from './build-plan.ts';

function inspectAll(fixture: BuildFixture): Promise<AssetInspection[]> {
  const plan = planBuild(fixture.project.config, fixture.lock);
  const building: AssetBuilding = {
    layout: fixture.layout,
    assets: plan.assets,
    fingerprint: encoderFingerprint(),
    maxImagePixels: fixture.project.config.limits.maxImagePixels,
    concurrency: 1,
    imageGate: imageGateFor(2, 1),
  };
  return Promise.all(plan.assets.map((asset) => inspectAssetOutput(building, asset)));
}

function knownSources(inspected: readonly AssetInspection[]): string[] {
  return knownOutputsOf(inspected).map(({ record }) => record.source);
}

function derivativeUses(inspected: readonly AssetInspection[]): string[] {
  return knownOutputsOf(inspected).map(({ conversion }) => conversion.derivativeUse);
}

function wouldConvertCount(inspected: readonly AssetInspection[]): number {
  return inspected.filter((output) => 'wouldConvert' in output).length;
}

test('a dry run knows copies, reusable derivatives and what it would convert', async () => {
  const originals = [
    { source: 'voice.mp3', bytes: Buffer.from('ID3 voice'), category: 'voice' as const },
    { source: 'art.png', bytes: await pngOf(transparentArtwork()), profile: 'flexible' },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const before = await inspectAll(fixture);
    assert.deepEqual(knownSources(before), ['voice.mp3']);
    assert.equal(wouldConvertCount(before), 1);
    await buildAllOutputs(fixture);
    assert.deepEqual(derivativeUses(await inspectAll(fixture)), ['copied', 'reused']);
  });
});

test('a reusable derivative whose type moves it off its planned paths is still refused', async () => {
  const misnamed = [
    { source: 'art.webp', bytes: await paletteNoisePng(), profile: 'lossy-flexible' },
  ];
  await withBuildFixture(misnamed, FAILURE_PROFILES, async (fixture) => {
    await buildAllOutputs(fixture);
    const inspected = await inspectAll(fixture);
    assert.deepEqual(issueSummaries(refusalsOf(inspected)), ['OUTPUT_TYPE_UNEXPECTED art.webp']);
  });
});
