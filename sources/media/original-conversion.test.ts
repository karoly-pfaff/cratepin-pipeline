import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import type { WebpEncoding } from '../config/pipeline-config.ts';
import { encoderFingerprint } from './encoding/encoder-fingerprint.ts';
import {
  gradientBackgroundPng,
  paletteNoisePng,
  pngOf,
  storedPixelsOf,
  transparentArtwork,
} from './testing/media-fixtures.test-support.ts';
import { convertOriginal } from './original-conversion.ts';
import type { ConvertedOriginal } from './original-conversion.ts';
import { derivativeKeyOf, normalizedPolicyOf } from './policies/transform-policy.ts';

const MAX_PIXELS = 16_383 * 16_383;
const LOSSY: WebpEncoding = { lossless: false, quality: 90, alphaQuality: 100, keepSmaller: true };

function original(bytes: Uint8Array): { readonly bytes: Uint8Array; readonly mediaType: string } {
  return { bytes, mediaType: 'image/png' };
}

function webpPolicy(webp: WebpEncoding, resize?: { width: number; height: number }) {
  return normalizedPolicyOf({
    kind: 'image',
    webp,
    ...(resize === undefined ? {} : { resize: { ...resize, fit: 'contain' as const } }),
  });
}

function codesOf(converted: ConvertedOriginal): string[] {
  return converted.notices.map((notice) => notice.code);
}

test('copy keeps the bytes and reports nothing saved', async () => {
  const bytes = await pngOf(transparentArtwork());
  const copied = await convertOriginal(original(bytes), { kind: 'copy' }, MAX_PIXELS);
  assert.equal(copied.choice, 'copied');
  assert.ok(Buffer.from(copied.bytes).equals(bytes));
  assert.deepEqual(
    [copied.sourceBytes, copied.outputBytes, copied.savedBytes],
    [bytes.length, bytes.length, 0],
  );
});

test('a flexible profile keeps the untouched original when WebP would be larger', async () => {
  const bytes = await paletteNoisePng();
  const kept = await convertOriginal(original(bytes), webpPolicy(LOSSY), MAX_PIXELS);
  assert.equal(kept.choice, 'kept-smaller');
  assert.equal(kept.mediaType, 'image/png', 'the real format, not the declared one');
  assert.ok(Buffer.from(kept.bytes).equals(bytes), 'byte for byte the original');
  assert.equal(kept.savedBytes, 0);
  assert.deepEqual(codesOf(kept), ['KEPT_SMALLER_FORMAT']);
});

test('a flexible profile whose box leaves the image as it is keeps the untouched original', async () => {
  const bytes = await paletteNoisePng();
  const roomyBox = normalizedPolicyOf({
    kind: 'image',
    resize: { width: 256, height: 256, fit: 'inside' },
    webp: LOSSY,
  });
  const kept = await convertOriginal(original(bytes), roomyBox, MAX_PIXELS);
  assert.equal(kept.choice, 'kept-smaller');
  assert.ok(Buffer.from(kept.bytes).equals(bytes), 'not a larger re-encode');
  assert.equal(kept.savedBytes, 0);
});

test('a loosely compressed original loses to its own re-encode when the geometry is kept', async () => {
  const loose = await sharp(await paletteNoisePng())
    .png({ compressionLevel: 0 })
    .toBuffer();
  const roomyBox = normalizedPolicyOf({
    kind: 'image',
    resize: { width: 256, height: 256, fit: 'inside' },
    webp: LOSSY,
  });
  const kept = await convertOriginal(original(loose), roomyBox, MAX_PIXELS);
  assert.equal(kept.choice, 'kept-smaller');
  assert.equal(kept.mediaType, 'image/png');
  assert.ok(kept.outputBytes < loose.length, 'the smaller same-format output, not the original');
  assert.deepEqual(codesOf(kept), ['KEPT_SMALLER_FORMAT']);
});

test('a flexible resizing profile keeps its same-format output and says when that grew', async () => {
  const bytes = await paletteNoisePng();
  const paddedBox = normalizedPolicyOf({
    kind: 'image',
    resize: { width: 256, height: 256, fit: 'contain' },
    webp: LOSSY,
  });
  const kept = await convertOriginal(original(bytes), paddedBox, MAX_PIXELS);
  assert.equal(kept.choice, 'kept-smaller');
  assert.equal(kept.mediaType, 'image/png');
  const size = await sharp(kept.bytes).metadata();
  assert.deepEqual([size.format, size.width, size.height], ['png', 256, 256]);
  assert.ok(kept.savedBytes < 0);
  assert.deepEqual(codesOf(kept), ['KEPT_SMALLER_FORMAT', 'SIZE_GREW']);
});

test('a same-format resize that grows says so without naming a WebP setting', async () => {
  const bytes = await paletteNoisePng();
  const box = normalizedPolicyOf({
    kind: 'image',
    resize: { width: 256, height: 256, fit: 'contain' },
  });
  const grown = await convertOriginal(original(bytes), box, MAX_PIXELS);
  assert.equal(grown.choice, 'converted');
  assert.deepEqual(codesOf(grown), ['SIZE_GREW']);
  assert.doesNotMatch(grown.notices[0]?.message ?? '', /strict|keepSmaller/u);
});

test('a strict profile keeps WebP although it grew, and reports the negative saving', async () => {
  const bytes = await paletteNoisePng();
  const strict = await convertOriginal(
    original(bytes),
    webpPolicy({ ...LOSSY, keepSmaller: false }),
    MAX_PIXELS,
  );
  assert.equal(strict.choice, 'converted');
  assert.equal(strict.mediaType, 'image/webp');
  assert.ok(strict.savedBytes < 0);
  assert.equal(strict.savedBytes, strict.sourceBytes - strict.outputBytes);
  assert.deepEqual(codesOf(strict), ['SIZE_GREW']);
});

test('a compressible background shrinks, and the saving is exactly source minus output', async () => {
  const bytes = await gradientBackgroundPng();
  const converted = await convertOriginal(
    original(bytes),
    webpPolicy({ ...LOSSY, quality: 80 }),
    MAX_PIXELS,
  );
  assert.equal(converted.choice, 'converted');
  assert.equal(converted.mediaType, 'image/webp');
  assert.equal(converted.sourceBytes, bytes.length);
  assert.equal(converted.outputBytes, converted.bytes.length);
  assert.equal(converted.savedBytes, bytes.length - converted.bytes.length);
  assert.ok(converted.outputBytes * 10 < converted.sourceBytes, 'more than 90 % smaller');
});

test('a changed quality changes both the bytes and the derivative key', async () => {
  const bytes = await gradientBackgroundPng();
  const q80 = webpPolicy({ ...LOSSY, quality: 80 });
  const q50 = webpPolicy({ ...LOSSY, quality: 50 });
  const at80 = await convertOriginal(original(bytes), q80, MAX_PIXELS);
  const at50 = await convertOriginal(original(bytes), q50, MAX_PIXELS);
  assert.ok(!Buffer.from(at80.bytes).equals(at50.bytes));
  const keyOf = (policy: typeof q80): string =>
    derivativeKeyOf({ sourceSha256: 'a'.repeat(64), policy, fingerprint: encoderFingerprint() });
  assert.notEqual(keyOf(q80), keyOf(q50));
});

test('lossy WebP keeps transparency instead of flattening it onto a background', async () => {
  const artwork = transparentArtwork(32, 32);
  const strict = webpPolicy({ ...LOSSY, keepSmaller: false });
  const converted = await convertOriginal(original(await pngOf(artwork)), strict, MAX_PIXELS);
  const decoded = await storedPixelsOf(converted.bytes);
  assert.deepEqual([decoded.width, decoded.height], [32, 32], 'no crop or resize');
  for (let index = 0; index < 32 * 32; index += 1) {
    const alpha = artwork.pixels[index * 4 + 3] ?? 0;
    if (alpha === 0 || alpha === 255) assert.equal(decoded.pixels[index * 4 + 3], alpha);
  }
});

test('the reported dimensions are those of the output, with the original alongside', async () => {
  const artwork = await pngOf(transparentArtwork(7, 5));
  const padded = await convertOriginal(
    original(artwork),
    normalizedPolicyOf({ kind: 'image', resize: { width: 16, height: 16, fit: 'contain' } }),
    MAX_PIXELS,
  );
  assert.deepEqual(
    [padded.dimensions, padded.sourceDimensions],
    [
      { width: 16, height: 16 },
      { width: 7, height: 5 },
    ],
  );
  const loose = await sharp(await paletteNoisePng())
    .png({ compressionLevel: 0 })
    .toBuffer();
  const halved = await convertOriginal(
    original(loose),
    normalizedPolicyOf({
      kind: 'image',
      resize: { width: 64, height: 64, fit: 'inside' },
      webp: LOSSY,
    }),
    MAX_PIXELS,
  );
  assert.deepEqual(
    [halved.dimensions, halved.sourceDimensions],
    [
      { width: 64, height: 64 },
      { width: 128, height: 128 },
    ],
  );
  const copied = await convertOriginal(original(artwork), { kind: 'copy' }, MAX_PIXELS);
  assert.deepEqual([copied.dimensions, copied.sourceDimensions], [undefined, undefined]);
});
