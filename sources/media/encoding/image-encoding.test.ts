import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { PipelineError } from '../../errors.ts';
import { encodeImage } from './image-encoding.ts';
import {
  displayP3Png,
  headerOnlyPng,
  noiseArtwork,
  pngOf,
  sixteenBitPng,
  storedPixelsOf,
  transparentArtwork,
  withAnimationControl,
  withDamagedPixelData,
} from '../testing/media-fixtures.test-support.ts';
import { convertStreaming } from './pixel-stages.ts';
import { normalizedPolicyOf } from '../policies/transform-policy.ts';
import type { ImagePolicy } from '../policies/transform-policy.ts';

const MAX_PIXELS = 16_383 * 16_383;
const WEBP = { lossless: true, quality: 80, alphaQuality: 100, keepSmaller: false };

function imagePolicy(profile: Parameters<typeof normalizedPolicyOf>[0]): ImagePolicy {
  const policy = normalizedPolicyOf(profile);
  if (policy.kind !== 'image') throw new Error('expected an image profile');
  return policy;
}

const LOSSLESS_WEBP = imagePolicy({ kind: 'image', webp: WEBP });
const RESIZE_ONLY = imagePolicy({
  kind: 'image',
  resize: { width: 64, height: 64, fit: 'inside' },
});

/** A predicate for `assert.rejects`: a media failure with `reason`, and these details. */
function failsBecause(
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof PipelineError, String(error));
    assert.equal(error.code, 'INVALID_DATA');
    assert.deepEqual(error.details, { reason, ...details });
    return true;
  };
}

function codesOf(notices: readonly { readonly code: string }[]): string[] {
  return notices.map((notice) => notice.code);
}

test('lossless WebP keeps geometry, every alpha value and the colour under transparent pixels', async () => {
  const artwork = transparentArtwork();
  const encoded = await encodeImage(await pngOf(artwork), LOSSLESS_WEBP, MAX_PIXELS);
  assert.equal(encoded.mediaType, 'image/webp');
  assert.deepEqual([encoded.width, encoded.height], [artwork.width, artwork.height]);
  const decoded = await storedPixelsOf(encoded.bytes);
  assert.ok(decoded.pixels.equals(artwork.pixels), 'pixel-identical RGBA');
  assert.deepEqual(encoded.notices, []);
});

test('the same input and policy give the same bytes again', async () => {
  const png = await pngOf(transparentArtwork());
  const first = await encodeImage(png, LOSSLESS_WEBP, MAX_PIXELS);
  const second = await encodeImage(png, LOSSLESS_WEBP, MAX_PIXELS);
  assert.ok(Buffer.from(first.bytes).equals(second.bytes));
});

test('an embedded colour profile is converted to untagged sRGB and reported', async () => {
  const p3 = await displayP3Png();
  const encoded = await encodeImage(p3, LOSSLESS_WEBP, MAX_PIXELS);
  assert.equal((await sharp(encoded.bytes).metadata()).icc, undefined, 'no profile in the output');
  const expected = await sharp(p3).ensureAlpha().raw().toBuffer();
  const stored = await storedPixelsOf(encoded.bytes);
  assert.ok(stored.pixels.equals(expected), 'what a colour-managed reader of the original sees');
  assert.ok(!stored.pixels.equals((await storedPixelsOf(p3)).pixels), 'not the stored P3 values');
  assert.deepEqual(codesOf(encoded.notices), ['COLOUR_CONVERTED']);
});

test('a 16-bit original is reduced to 8 bits and reported, whatever the output format', async () => {
  const original = await sixteenBitPng();
  for (const policy of [LOSSLESS_WEBP, RESIZE_ONLY]) {
    const encoded = await encodeImage(original, policy, MAX_PIXELS);
    assert.deepEqual(codesOf(encoded.notices), ['PRECISION_REDUCED'], encoded.format);
    assert.equal((await sharp(encoded.bytes).metadata()).depth, 'uchar', 'eight bits per sample');
  }
});

test('an image over the pixel limit is refused from its header, before decoding', async () => {
  const huge = headerOnlyPng(20_000, 20_000);
  const tooLarge = { width: 20_000, height: 20_000, maxImagePixels: MAX_PIXELS };
  await assert.rejects(
    encodeImage(huge, LOSSLESS_WEBP, MAX_PIXELS),
    failsBecause('IMAGE_TOO_LARGE', tooLarge),
  );
  const small = await pngOf(transparentArtwork(10, 10));
  const atLimit = { width: 10, height: 10, maxImagePixels: 99 };
  await assert.rejects(
    encodeImage(small, LOSSLESS_WEBP, 99),
    failsBecause('IMAGE_TOO_LARGE', atLimit),
  );
  assert.equal((await encodeImage(small, LOSSLESS_WEBP, 100)).width, 10);
});

test('a raised pixel limit lets a large header through to the next check', async () => {
  const huge = headerOnlyPng(20_000, 20_000);
  const raised = 20_000 * 20_000;
  await assert.rejects(
    encodeImage(huge, LOSSLESS_WEBP, raised),
    failsBecause('WEBP_EDGE_TOO_LONG', { width: 20_000, height: 20_000 }),
  );
  await assert.rejects(encodeImage(huge, RESIZE_ONLY, raised), failsBecause('IMAGE_UNREADABLE'));
});

test('the pixel budget covers the padded output before decoding, in PNG and WebP', async () => {
  for (const webp of [undefined, WEBP]) {
    const policy = imagePolicy({
      kind: 'image',
      resize: { width: 64, height: 64, fit: 'contain' },
      ...(webp === undefined ? {} : { webp }),
    });
    const tooLarge = failsBecause('IMAGE_TOO_LARGE', {
      width: 64,
      height: 64,
      maxImagePixels: 16,
    });
    await assert.rejects(encodeImage(headerOnlyPng(2, 2), policy, 16), tooLarge);
    const original = await pngOf(transparentArtwork(2, 2));
    await assert.rejects(encodeImage(original, policy, 16), tooLarge);
    const boundary = await encodeImage(original, policy, 4096);
    assert.deepEqual([boundary.width, boundary.height], [64, 64]);
    const inside = imagePolicy({
      kind: 'image',
      resize: { width: 64, height: 64, fit: 'inside' },
      ...(webp === undefined ? {} : { webp }),
    });
    const unpadded = await encodeImage(original, inside, 4);
    assert.deepEqual([unpadded.width, unpadded.height], [2, 2]);
  }
});

test('an output longer than WebP can store is refused with the remedy, not called damaged', async () => {
  const strip = await sharp({
    create: { width: 20_000, height: 2, channels: 4, background: '#00ff00' },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    encodeImage(strip, LOSSLESS_WEBP, MAX_PIXELS),
    failsBecause('WEBP_EDGE_TOO_LONG', { width: 20_000, height: 2 }),
  );
  const wideBox = imagePolicy({
    kind: 'image',
    resize: { width: 16_384, height: 64, fit: 'contain' },
    webp: WEBP,
  });
  await assert.rejects(
    encodeImage(await pngOf(transparentArtwork()), wideBox, MAX_PIXELS),
    failsBecause('WEBP_EDGE_TOO_LONG', { width: 16_384, height: 64 }),
  );
  assert.equal((await encodeImage(strip, RESIZE_ONLY, MAX_PIXELS)).format, 'png');
});

test('damaged, truncated and foreign data is unreadable, never converted', async () => {
  const png = await pngOf(noiseArtwork());
  const unreadable = [
    png.subarray(0, 30),
    png.subarray(0, Math.floor(png.length / 2)),
    withDamagedPixelData(png),
    Buffer.from('not an image at all'),
  ];
  for (const bytes of unreadable) {
    await assert.rejects(
      encodeImage(bytes, LOSSLESS_WEBP, MAX_PIXELS),
      failsBecause('IMAGE_UNREADABLE'),
    );
  }
});

test('animated PNG and other formats are refused with the profile to use instead', async () => {
  const animated = withAnimationControl(await pngOf(transparentArtwork()));
  await assert.rejects(
    encodeImage(animated, LOSSLESS_WEBP, MAX_PIXELS),
    failsBecause('ANIMATION_UNSUPPORTED', { format: 'png' }),
  );
  const gif = await sharp(await pngOf(transparentArtwork()))
    .gif()
    .toBuffer();
  await assert.rejects(
    encodeImage(gif, LOSSLESS_WEBP, 1),
    failsBecause('UNSUPPORTED_IMAGE_FORMAT', { format: 'gif' }),
    'the format is named before the size, as only the copy profile fits',
  );
});

test('a resize fits the box with transparent padding and never enlarges', async () => {
  const background = { r: 0, g: 128, b: 0, alpha: 1 };
  const wide = await sharp({ create: { width: 100, height: 50, channels: 4, background } })
    .png()
    .toBuffer();
  const box = imagePolicy({ kind: 'image', resize: { width: 64, height: 64, fit: 'contain' } });
  const contained = await encodeImage(wide, box, MAX_PIXELS);
  assert.equal(contained.mediaType, 'image/png');
  assert.deepEqual([contained.width, contained.height], [64, 64]);
  assert.equal((await storedPixelsOf(contained.bytes)).pixels[3], 0, 'padding is transparent');
  const large = imagePolicy({ kind: 'image', resize: { width: 512, height: 512, fit: 'inside' } });
  const untouched = await encodeImage(wide, large, MAX_PIXELS);
  assert.deepEqual([untouched.width, untouched.height], [100, 50]);
});

test('a failure of the encoder itself is ENCODING_FAILED, never blamed on the original', async () => {
  const strip = await sharp({
    create: { width: 20_000, height: 2, channels: 4, background: '#0f0' },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    convertStreaming(strip, LOSSLESS_WEBP, MAX_PIXELS),
    failsBecause('ENCODING_FAILED'),
  );
});

test('grey, grey with alpha and palette originals convert exactly and pad transparently', async () => {
  const sources = [
    await sharp(await pngOf(transparentArtwork()))
      .toColourspace('b-w')
      .png()
      .toBuffer(),
    await sharp(await pngOf(transparentArtwork()))
      .png({ palette: true })
      .toBuffer(),
    await sharp({ create: { width: 6, height: 3, channels: 3, background: '#808080' } })
      .toColourspace('b-w')
      .png()
      .toBuffer(),
  ];
  const box = imagePolicy({ kind: 'image', resize: { width: 6, height: 6, fit: 'contain' } });
  for (const source of sources) {
    const lossless = await encodeImage(source, LOSSLESS_WEBP, MAX_PIXELS);
    const expected = await sharp(source).ensureAlpha().raw().toBuffer();
    assert.ok(
      (await storedPixelsOf(lossless.bytes)).pixels.equals(expected),
      'decoded pixels kept',
    );
    const padded = await encodeImage(source, box, MAX_PIXELS);
    assert.equal(padded.height, 6);
    assert.equal((await storedPixelsOf(padded.bytes)).pixels[3], 0, 'transparent padding');
  }
});

test('an opaque original is padded transparently too', async () => {
  const opaque = await sharp({
    create: { width: 10, height: 4, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  const box = imagePolicy({ kind: 'image', resize: { width: 10, height: 10, fit: 'contain' } });
  const contained = await encodeImage(opaque, box, MAX_PIXELS);
  const stored = await storedPixelsOf(contained.bytes);
  assert.equal(stored.pixels[3], 0, 'the padding row is transparent');
});

test('lossless quality changes the bytes and their size, never the pixels', async () => {
  const artwork = transparentArtwork(64, 64);
  const original = await pngOf(artwork);
  const atQuality = (quality: number) =>
    encodeImage(original, imagePolicy({ kind: 'image', webp: { ...WEBP, quality } }), MAX_PIXELS);
  const [fast, thorough] = await Promise.all([atQuality(1), atQuality(80)]);
  assert.ok(!Buffer.from(fast.bytes).equals(thorough.bytes));
  assert.notEqual(fast.bytes.length, thorough.bytes.length);
  for (const encoded of [fast, thorough]) {
    assert.ok((await storedPixelsOf(encoded.bytes)).pixels.equals(artwork.pixels));
  }
});

test('a contain box pads a smaller image to the box without enlarging it', async () => {
  const background = { r: 0, g: 128, b: 0, alpha: 1 };
  const small = await sharp({ create: { width: 100, height: 50, channels: 4, background } })
    .png()
    .toBuffer();
  const actorBox = imagePolicy({
    kind: 'image',
    resize: { width: 512, height: 512, fit: 'contain' },
  });
  const padded = await encodeImage(small, actorBox, MAX_PIXELS);
  assert.deepEqual([padded.width, padded.height], [512, 512]);
  const content = await sharp(padded.bytes).trim().toBuffer({ resolveWithObject: true });
  assert.deepEqual(
    [content.info.width, content.info.height],
    [100, 50],
    'the content keeps its size',
  );
});
