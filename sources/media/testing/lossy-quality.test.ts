import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { encoderFingerprint } from '../encoding/encoder-fingerprint.ts';
import { encodeImage } from '../encoding/image-encoding.ts';
import { lossyFixtures } from './lossy-fixtures.test-support.ts';
import { normalizedPolicyOf } from '../policies/transform-policy.ts';
import type { ImagePolicy } from '../policies/transform-policy.ts';
import { visualDifferenceOf } from './visual-comparison.test-support.ts';
import type { VisualDifference } from './visual-comparison.test-support.ts';

// Lossy WebP is checked by what it shows, not only by its size: on three kinds of art it must
// keep the geometry and alpha exactly and stay within the colour tolerances documented in
// docs/contribution/media-semantics.md, with a margin beyond the pinned encoder's measurements;
// a person reviews the actual samples (docs/contribution/visual-review.md).

const MAX_PIXELS = 8192 * 8192;
const QUALITIES = [50, 80, 82, 90];
/** The quality range the tolerances hold for; lower qualities only keep the invariants. */
const TOLERATED_FROM_QUALITY = 80;

/**
 * Per fixture, for quality 80 and up: the least PSNR (dB), the most mean absolute error and the
 * most error 99.9 % of samples stay within (which catches a local artefact the means hide).
 */
const TOLERANCES: Readonly<
  Record<
    string,
    { readonly psnr: number; readonly meanAbsoluteError: number; readonly deltaAt999: number }
  >
> = {
  'smooth-background': { psnr: 42, meanAbsoluteError: 1.5, deltaAt999: 8 },
  'soft-edged-sprite': { psnr: 42, meanAbsoluteError: 1.5, deltaAt999: 9 },
  'saturated-scene': { psnr: 26, meanAbsoluteError: 4.5, deltaAt999: 112 },
};

function lossyPolicy(quality: number, alphaQuality: number): ImagePolicy {
  const webp = { lossless: false, quality, alphaQuality, keepSmaller: false };
  const policy = normalizedPolicyOf({ kind: 'image', webp });
  if (policy.kind !== 'image') throw new Error('expected an image profile');
  return policy;
}

async function differenceAt(
  png: Buffer,
  quality: number,
  alphaQuality = 100,
): Promise<VisualDifference> {
  const encoded = await encodeImage(png, lossyPolicy(quality, alphaQuality), MAX_PIXELS);
  return visualDifferenceOf(png, encoded.bytes);
}

test('lossy WebP keeps geometry and alpha exactly at every quality; transparency never flips', async () => {
  for (const [name, png] of Object.entries(await lossyFixtures())) {
    for (const quality of QUALITIES) {
      const full = await differenceAt(png, quality);
      assert.deepEqual(
        [full.sameGeometry, full.maxAlphaDelta, full.transparencyFlips],
        [true, 0, 0],
        `${name} q${String(quality)}`,
      );
      const halfAlpha = await differenceAt(png, quality, 50);
      assert.equal(halfAlpha.transparencyFlips, 0, `${name} q${String(quality)} alphaQuality 50`);
    }
  }
});

test('lossy WebP from quality 80 stays within each kind of art’s colour tolerance', async () => {
  for (const [name, png] of Object.entries(await lossyFixtures())) {
    const tolerance = TOLERANCES[name];
    assert.ok(tolerance !== undefined, name);
    for (const quality of QUALITIES.filter((value) => value >= TOLERATED_FROM_QUALITY)) {
      const difference = await differenceAt(png, quality);
      const label = `${name} q${String(quality)}: ${difference.psnr.toFixed(2)} dB, MAE ${difference.meanAbsoluteError.toFixed(3)}`;
      assert.ok(difference.psnr >= tolerance.psnr, label);
      assert.ok(difference.meanAbsoluteError <= tolerance.meanAbsoluteError, label);
      assert.ok(
        difference.deltaAt999 <= tolerance.deltaAt999,
        `${label}, p99.9 ${String(difference.deltaAt999)}`,
      );
    }
  }
});

test('a higher quality never makes the mean colour error noticeably worse', async () => {
  for (const [name, png] of Object.entries(await lossyFixtures())) {
    const errors = await Promise.all(
      QUALITIES.map(async (quality) => (await differenceAt(png, quality)).meanAbsoluteError),
    );
    // Against the best lower quality, so small steps cannot add up to a large rise.
    let best = Infinity;
    for (const error of errors) {
      assert.ok(error <= best + 0.25, `${name}: ${errors.join(', ')}`);
      best = Math.min(best, error);
    }
  }
});

/** A person's decision on the lossy samples one encoder made; see docs/contribution/visual-review.md. */
interface ReviewRecord {
  readonly decision: 'pending' | 'approved' | 'rejected';
  readonly fingerprint: unknown;
  readonly samples: readonly {
    readonly fixture: string;
    readonly quality: number;
    readonly outputSha256: string;
  }[];
}

async function reviewRecord(): Promise<ReviewRecord> {
  const text = await readFile(new URL('./reviewed-lossy-samples.json', import.meta.url), 'utf8');
  return JSON.parse(text) as ReviewRecord;
}

test('approved lossy samples stay byte for byte what was reviewed, for the reviewed encoder', async (context) => {
  const record = await reviewRecord();
  const isSameEncoder = JSON.stringify(record.fingerprint) === JSON.stringify(encoderFingerprint());
  assert.ok(
    ['pending', 'approved', 'rejected'].includes(record.decision),
    `unknown decision ${record.decision}`,
  );
  assert.ok(!(isSameEncoder && record.decision === 'rejected'), 'a person rejected these samples');
  if (record.decision !== 'approved' || !isSameEncoder) {
    context.diagnostic(
      `lossy samples: review ${record.decision}${isSameEncoder ? '' : ', for another encoder'}`,
    );
    return;
  }
  assert.ok(record.samples.length > 0, 'an approval names the samples it covers');
  const fixtures = await lossyFixtures();
  for (const { fixture, quality, outputSha256 } of record.samples) {
    const png = fixtures[fixture];
    assert.ok(png !== undefined, fixture);
    const encoded = await encodeImage(png, lossyPolicy(quality, 100), MAX_PIXELS);
    assert.equal(
      createHash('sha256').update(encoded.bytes).digest('hex'),
      outputSha256,
      `${fixture} q${String(quality)} changed since its review`,
    );
  }
});
