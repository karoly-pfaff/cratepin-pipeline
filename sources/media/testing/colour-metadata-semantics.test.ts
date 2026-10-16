import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { encodeImage } from '../encoding/image-encoding.ts';
import { convertOriginal } from '../original-conversion.ts';
import {
  chunkContentsOf,
  pixelsOf,
  pngChunk,
  pngOf,
  sixteenBitGreyPng,
  storedPixelsOf,
  withChunksAfterHeader,
} from './media-fixtures.test-support.ts';
import { normalizedPolicyOf } from '../policies/transform-policy.ts';
import type { ImagePolicy } from '../policies/transform-policy.ts';

// What a conversion promises about colour and metadata, sample by sample: each test is one row
// of the expected-output table in docs/contribution/media-semantics.md.

const MAX_PIXELS = 8192 * 8192;
const LOSSLESS = { lossless: true, quality: 80, alphaQuality: 100, keepSmaller: false };
const ORANGE = { r: 200, g: 100, b: 50 };

function imagePolicy(profile: Parameters<typeof normalizedPolicyOf>[0]): ImagePolicy {
  const policy = normalizedPolicyOf(profile);
  if (policy.kind !== 'image') throw new Error('expected an image profile');
  return policy;
}

const LOSSLESS_WEBP = imagePolicy({ kind: 'image', webp: LOSSLESS });
/** A resize that keeps the size: the output stays PNG. */
const SAME_FORMAT_PNG = imagePolicy({
  kind: 'image',
  resize: { width: 64, height: 64, fit: 'inside' },
});

function codesOf(notices: readonly { readonly code: string }[]): string[] {
  return notices.map((notice) => notice.code);
}

/** Every channel of the first pixel within ±1 of `expected`. */
function assertNear(actual: Buffer, expected: readonly number[]): void {
  expected.forEach((value, channel) => {
    assert.ok(
      Math.abs((actual[channel] ?? -9) - value) <= 1,
      `channel ${String(channel)}: ${String(actual[channel])} vs ${String(value)}`,
    );
  });
}

/** The same orange, as Display P3 samples tagged with the P3 profile, optionally half transparent. */
function displayP3Orange(alpha: number): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: { ...ORANGE, alpha } } })
    .withIccProfile('p3')
    .png()
    .toBuffer();
}

test('a Display P3 original becomes the sRGB colour it was made from, untagged, in WebP and PNG', async () => {
  for (const policy of [LOSSLESS_WEBP, SAME_FORMAT_PNG]) {
    const encoded = await encodeImage(await displayP3Orange(1), policy, MAX_PIXELS);
    assert.equal((await sharp(encoded.bytes).metadata()).icc, undefined, encoded.mediaType);
    assertNear((await storedPixelsOf(encoded.bytes)).pixels, [200, 100, 50, 255]);
    assert.deepEqual(codesOf(encoded.notices), ['COLOUR_CONVERTED']);
  }
});

test('a Display P3 original with alpha keeps its alpha exactly', async () => {
  const encoded = await encodeImage(await displayP3Orange(128 / 255), LOSSLESS_WEBP, MAX_PIXELS);
  const { pixels } = await storedPixelsOf(encoded.bytes);
  assert.equal(pixels[3], 128);
  assertNear(pixels, [200, 100, 50]);
});

test('an sRGB-tagged original keeps its samples and still reports the conversion', async () => {
  const tagged = await sharp(await pngOf(pixelsOf(3, 2, () => [200, 100, 50, 255])))
    .withIccProfile('srgb')
    .png()
    .toBuffer();
  const encoded = await encodeImage(tagged, LOSSLESS_WEBP, MAX_PIXELS);
  assert.ok(
    (await storedPixelsOf(encoded.bytes)).pixels.equals((await storedPixelsOf(tagged)).pixels),
  );
  assert.deepEqual(codesOf(encoded.notices), ['COLOUR_CONVERTED']);
});

const SIXTEEN_BIT_SAMPLES = [0, 127, 128, 255, 256, 383, 384, 32767, 32768, 65279, 65280, 65535];

test('a 16-bit original keeps the high byte of every sample', async () => {
  const encoded = await encodeImage(
    sixteenBitGreyPng(SIXTEEN_BIT_SAMPLES),
    LOSSLESS_WEBP,
    MAX_PIXELS,
  );
  const { pixels } = await storedPixelsOf(encoded.bytes);
  const greys = SIXTEEN_BIT_SAMPLES.map((_, index) => pixels[index * 4]);
  assert.deepEqual(
    greys,
    SIXTEEN_BIT_SAMPLES.map((sample) => sample >> 8),
  );
  assert.deepEqual(codesOf(encoded.notices), ['PRECISION_REDUCED']);
});

/** A gamma of 1.0 and chromaticities: both tell a reader to change the samples. */
function colourHintChunks(): Buffer[] {
  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(100_000);
  const chromaticities = Buffer.alloc(32);
  [31_270, 32_900, 64_000, 33_000, 30_000, 60_000, 15_000, 6000].forEach((value, index) => {
    chromaticities.writeUInt32BE(value, index * 4);
  });
  return [pngChunk('gAMA', gamma), pngChunk('cHRM', chromaticities)];
}

test('gamma and chromaticity chunks are not applied: the stored samples are kept', async () => {
  const plain = await pngOf(pixelsOf(3, 2, () => [200, 100, 50, 255]));
  const hinted = withChunksAfterHeader(plain, colourHintChunks());
  const encoded = await encodeImage(hinted, LOSSLESS_WEBP, MAX_PIXELS);
  assert.ok(
    (await storedPixelsOf(encoded.bytes)).pixels.equals((await storedPixelsOf(plain)).pixels),
  );
});

const MARKERS = {
  comment: 'comment-marker-7d1',
  xmp: 'xmp-marker-3c9',
  credentials: 'c2pa-marker-5e2',
};

/** Text, XMP, EXIF, content credentials and gamma, each with a marker that must not survive. */
function metadataChunks(): Buffer[] {
  const exif = Buffer.from(
    `MM\u0000*\u0000\u0000\u0000\u0008\u0000\u0000${MARKERS.comment}`,
    'latin1',
  );
  return [
    pngChunk('tEXt', Buffer.from(`Comment\u0000${MARKERS.comment}`, 'latin1')),
    pngChunk(
      'iTXt',
      Buffer.from(`XML:com.adobe.xmp\u0000\u0000\u0000\u0000\u0000${MARKERS.xmp}`, 'latin1'),
    ),
    pngChunk('eXIf', exif),
    pngChunk('caBX', Buffer.from(MARKERS.credentials, 'latin1')),
    ...colourHintChunks().slice(0, 1),
  ];
}

test('converted output drops text, XMP, EXIF, content credentials and gamma', async () => {
  const tagged = withChunksAfterHeader(
    await pngOf(pixelsOf(4, 4, () => [10, 20, 30, 255])),
    metadataChunks(),
  );
  for (const policy of [LOSSLESS_WEBP, SAME_FORMAT_PNG]) {
    const output = Buffer.from((await encodeImage(tagged, policy, MAX_PIXELS)).bytes);
    for (const marker of Object.values(MARKERS))
      assert.ok(!output.includes(marker), `${marker} survived`);
    const metadata = await sharp(output).metadata();
    assert.deepEqual([metadata.exif, metadata.xmp], [undefined, undefined]);
  }
  const png = Buffer.from((await encodeImage(tagged, SAME_FORMAT_PNG, MAX_PIXELS)).bytes);
  for (const type of ['tEXt', 'iTXt', 'eXIf', 'caBX', 'gAMA'])
    assert.deepEqual(chunkContentsOf(png, type), [], type);
});

test('the copy profile keeps every metadata chunk, byte for byte', async () => {
  const tagged = withChunksAfterHeader(
    await pngOf(pixelsOf(4, 4, () => [10, 20, 30, 255])),
    metadataChunks(),
  );
  const copied = await convertOriginal(
    { bytes: tagged, mediaType: 'image/png' },
    { kind: 'copy' },
    MAX_PIXELS,
  );
  assert.ok(Buffer.from(copied.bytes).equals(tagged));
});
