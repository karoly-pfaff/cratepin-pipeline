import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import { storedPixelsOf } from '../../sources/media/testing/media-fixtures.test-support.ts';
import { visualDifferenceOf } from '../../sources/media/testing/visual-comparison.test-support.ts';

export const EVALUATION_PROFILES = [
  { name: 'png', format: 'png', options: { compressionLevel: 9 } },
  { name: 'webp-lossless', format: 'webp', options: { lossless: true, exact: true, effort: 4 } },
  { name: 'webp-lossy', format: 'webp', options: { quality: 80, alphaQuality: 100, effort: 4 } },
  {
    name: 'avif-lossless',
    format: 'avif',
    options: { lossless: true, effort: 4, chromaSubsampling: '4:4:4' },
  },
  {
    name: 'avif-lossy',
    format: 'avif',
    options: { quality: 60, effort: 4, chromaSubsampling: '4:4:4' },
  },
];

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function encodeVariant(original, selection) {
  return sharp(original, { failOn: 'error', limitInputPixels: 1024 * 1024 })
    .resize({ width: selection.width, withoutEnlargement: true, kernel: 'lanczos3' })
    .toColourspace('srgb')
    .toFormat(selection.profile.format, selection.profile.options)
    .toBuffer();
}

async function compareDecodedPixels(reference, output) {
  const before = await storedPixelsOf(reference);
  const after = await storedPixelsOf(output);
  const difference = await visualDifferenceOf(reference, output);
  return {
    width: after.width,
    height: after.height,
    isExactRgba: difference.sameGeometry && before.pixels.equals(after.pixels),
    ...difference,
    psnr: Number.isFinite(difference.psnr) ? difference.psnr : null,
  };
}

/** Experimental measurement only: never changes production profiles or manifests. */
export async function evaluateVariant(original, selection) {
  const startedAt = performance.now();
  const output = await encodeVariant(original, selection);
  const encodingMs = performance.now() - startedAt;
  const repeated = await encodeVariant(original, selection);
  const reference = await encodeVariant(original, {
    ...selection,
    profile: EVALUATION_PROFILES[0],
  });
  return {
    output,
    measurement: {
      profile: selection.profile.name,
      format: selection.profile.format,
      encoding: selection.profile.options,
      requestedWidth: selection.width,
      sourceBytes: original.length,
      outputBytes: output.length,
      savedBytes: original.length - output.length,
      sha256: sha256Of(output),
      encodingMs,
      isRepeatable: output.equals(repeated),
      comparison: await compareDecodedPixels(reference, output),
    },
  };
}
