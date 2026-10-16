import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  EVALUATION_PROFILES,
  evaluateVariant,
  sha256Of,
} from './variant-evaluation.test-support.mjs';
import { writeVariantEvaluation } from './variant-report.test-support.mjs';
import {
  pngOf,
  transparentArtwork,
} from '../../sources/media/testing/media-fixtures.test-support.ts';
import { withTempDirectory } from '../support/cli-runs.test-support.mjs';

test('variant evaluation measures actual codecs, repetition, alpha and half-size geometry without mutating the original', async () => {
  const original = await pngOf(transparentArtwork(16, 16));
  const originalHash = sha256Of(original);
  for (const profile of EVALUATION_PROFILES) {
    const { output, measurement } = await evaluateVariant(original, { width: 8, profile });
    assert.equal(measurement.isRepeatable, true);
    assert.equal(measurement.comparison.sameGeometry, true);
    assert.deepEqual([measurement.comparison.width, measurement.comparison.height], [8, 8]);
    assert.equal(measurement.sha256, sha256Of(output));
    assert.equal(measurement.savedBytes, original.length - output.length);
    assert.ok(measurement.encodingMs >= 0);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, profile.format === 'avif' ? 'heif' : profile.format);
    if (profile.options.lossless || profile.format === 'png') {
      assert.equal(measurement.comparison.isExactRgba, true);
      assert.equal(measurement.comparison.maxAlphaDelta, 0);
    }
  }
  assert.equal(sha256Of(original), originalHash);
});

test('experimental variant manifests preserve logical IDs and original fallback hashes at each measured size', async () => {
  await withTempDirectory(async (parent) => {
    const directory = await writeVariantEvaluation(parent);
    const report = JSON.parse(await readFile(join(directory, 'variant-evaluation.json'), 'utf8'));
    assert.equal(report.kind, 'experimental-variant-evaluation');
    assert.equal(Object.keys(report.assets).length, 4);
    for (const [id, asset] of Object.entries(report.assets)) {
      assert.equal(asset.fallback.url, `${id}.png`);
      assert.equal(
        sha256Of(await readFile(join(directory, asset.fallback.url))),
        asset.fallback.sha256,
      );
      assert.equal(asset.variants.length, 10);
      for (const variant of asset.variants)
        assert.equal(sha256Of(await readFile(join(directory, variant.url))), variant.sha256);
    }
    assert.ok((await readdir(directory)).includes('index.html'));
    assert.equal(report.encoders.sharp, '0.35.5');
  });
});
