import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { encodeImage } from '../encoding/image-encoding.ts';
import {
  pixelsOf,
  pngChunk,
  pngOf,
  storedPixelsOf,
  transparentArtwork,
  withChunksAfterHeader,
} from './media-fixtures.test-support.ts';
import type { RawImage } from './media-fixtures.test-support.ts';
import { normalizedPolicyOf } from '../policies/transform-policy.ts';
import type { ImagePolicy } from '../policies/transform-policy.ts';

// What a conversion promises about alpha and geometry, pixel by pixel: each test is one row of
// the expected-output table in docs/contribution/media-semantics.md.

const MAX_PIXELS = 8192 * 8192;
const LOSSLESS = { lossless: true, quality: 80, alphaQuality: 100, keepSmaller: false };
const TRANSPARENT = [0, 0, 0, 0];
const SLATE = [51, 102, 153, 255];

function imagePolicy(profile: Parameters<typeof normalizedPolicyOf>[0]): ImagePolicy {
  const policy = normalizedPolicyOf(profile);
  if (policy.kind !== 'image') throw new Error('expected an image profile');
  return policy;
}

/** Lossless WebP in a box, so the decoded pixels are exactly what the resize made. */
function boxed(width: number, height: number, fit: 'contain' | 'inside'): ImagePolicy {
  return imagePolicy({ kind: 'image', webp: LOSSLESS, resize: { width, height, fit } });
}

function lossy(alphaQuality: number): ImagePolicy {
  const webp = { lossless: false, quality: 82, alphaQuality, keepSmaller: false };
  return imagePolicy({ kind: 'image', webp });
}

async function decodedOf(image: RawImage, policy: ImagePolicy): Promise<RawImage> {
  return storedPixelsOf((await encodeImage(await pngOf(image), policy, MAX_PIXELS)).bytes);
}

function alphaAt(image: RawImage, index: number): number {
  return image.pixels[index * 4 + 3] ?? -1;
}

function pixelIndexes(image: RawImage): number[] {
  return Array.from({ length: image.width * image.height }, (_, index) => index);
}

test('lossy with full alpha quality keeps every alpha value', async () => {
  // All 256 alpha levels: libwebp keeps fewer levels exactly even below 100, so only a full
  // ramp shows whether 100 reached the encoder.
  const ramp = pixelsOf(256, 4, (column) => [100, 150, 200, column]);
  const decoded = await decodedOf(ramp, lossy(100));
  for (const index of pixelIndexes(ramp))
    assert.equal(alphaAt(decoded, index), alphaAt(ramp, index));
});

test('below full alpha quality only fully transparent and fully opaque pixels are promised', async () => {
  const artwork = transparentArtwork(64, 64);
  const decoded = await decodedOf(artwork, lossy(50));
  const extremes = pixelIndexes(artwork).filter((index) =>
    [0, 255].includes(alphaAt(artwork, index)),
  );
  assert.ok(extremes.length > 0);
  for (const index of extremes) assert.equal(alphaAt(decoded, index), alphaAt(artwork, index));
});

/** Transparent red on the left half (red hidden under alpha 0), opaque green on the right. */
function hiddenRedBesideGreen(): RawImage {
  return pixelsOf(32, 32, (column) => (column < 16 ? [255, 0, 0, 0] : [0, 200, 0, 255]));
}

function isTransparentAt(image: RawImage): (index: number) => boolean {
  return (index) => alphaAt(image, index) === 0;
}

test('a resize clears the colour under transparent pixels and never bleeds it into visible ones', async () => {
  const decoded = await decodedOf(hiddenRedBesideGreen(), boxed(16, 16, 'inside'));
  assert.deepEqual([decoded.width, decoded.height], [16, 16]);
  const transparent = pixelIndexes(decoded).filter(isTransparentAt(decoded));
  assert.ok(transparent.length > 0, 'the resize keeps fully transparent pixels');
  for (const index of pixelIndexes(decoded)) {
    const [red, green, blue, alpha] = decoded.pixels.subarray(index * 4, index * 4 + 4);
    if (alpha === 0) assert.deepEqual([red, green, blue], [0, 0, 0], 'transparent is 0,0,0,0');
    else assert.equal(red, 0, 'no red from transparent neighbours');
  }
});

test('a box the image already fits does not resample: hidden colour stays, padding is 0,0,0,0', async () => {
  const decoded = await decodedOf(hiddenRedBesideGreen(), boxed(64, 32, 'contain'));
  const expected = pixelsOf(64, 32, (column) => {
    if (column < 16 || column >= 48) return TRANSPARENT;
    return column < 32 ? [255, 0, 0, 0] : [0, 200, 0, 255];
  });
  assert.ok(decoded.pixels.equals(expected.pixels), 'centred as it is, hidden red included');
});

test('an opaque original stays without alpha in lossless WebP; padding adds alpha', async () => {
  const opaque = await sharp({
    create: { width: 10, height: 4, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  const plain = await encodeImage(opaque, boxed(10, 4, 'inside'), MAX_PIXELS);
  assert.equal((await sharp(plain.bytes).metadata()).hasAlpha, false);
  const padded = await encodeImage(opaque, boxed(10, 10, 'contain'), MAX_PIXELS);
  assert.equal((await sharp(padded.bytes).metadata()).hasAlpha, true);
});

/** A `width`×`height` box with SLATE on `isContent` pixels and transparency elsewhere. */
function expectedBox(
  width: number,
  height: number,
  isContent: (column: number, row: number) => boolean,
): RawImage {
  return pixelsOf(width, height, (column, row) => (isContent(column, row) ? SLATE : TRANSPARENT));
}

test('contain centres a smaller image; the odd row or column of padding goes to the bottom or right', async () => {
  const wide = pixelsOf(10, 3, () => SLATE);
  const placedWide = await decodedOf(wide, boxed(10, 8, 'contain'));
  const expectedWide = expectedBox(10, 8, (_, row) => row >= 2 && row <= 4);
  assert.ok(placedWide.pixels.equals(expectedWide.pixels), 'rows 2 to 4, padding exactly 0,0,0,0');
  const tall = pixelsOf(3, 10, () => SLATE);
  const placedTall = await decodedOf(tall, boxed(8, 10, 'contain'));
  const expectedTall = expectedBox(8, 10, (column) => column >= 2 && column <= 4);
  assert.ok(placedTall.pixels.equals(expectedTall.pixels), 'columns 2 to 4');
});

test('contain with a downscale fills the full width and centres the rows', async () => {
  const decoded = await decodedOf(
    pixelsOf(101, 51, () => SLATE),
    boxed(64, 64, 'contain'),
  );
  for (const index of pixelIndexes(decoded)) {
    const row = Math.floor(index / 64);
    const isContent = row >= 16 && row <= 47;
    assert.equal(alphaAt(decoded, index), isContent ? 255 : 0, `row ${String(row)}`);
  }
});

/** Source size, box, expected output size of `inside`. */
const INSIDE_SIZES: readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
][] = [
  [
    [101, 51],
    [64, 64],
    [64, 32],
  ],
  [
    [7, 5],
    [4, 4],
    [4, 3],
  ],
  [
    [17, 13],
    [10, 10],
    [10, 8],
  ],
  [
    [999, 1],
    [10, 10],
    [10, 1],
  ],
  [
    [100, 50],
    [512, 512],
    [100, 50],
  ],
];

test('inside rounds each side to the nearest pixel, never to zero, and never enlarges', async () => {
  for (const [[width, height], [boxWidth, boxHeight], expected] of INSIDE_SIZES) {
    const decoded = await decodedOf(
      pixelsOf(width, height, () => SLATE),
      boxed(boxWidth, boxHeight, 'inside'),
    );
    assert.deepEqual(
      [decoded.width, decoded.height],
      expected,
      `${String(width)}×${String(height)}`,
    );
  }
});

/** A minimal big-endian EXIF block holding only an orientation. */
function exifWithOrientation(orientation: number): Buffer {
  const exif = Buffer.alloc(26);
  exif.write('MM', 0, 'latin1');
  exif.writeUInt16BE(42, 2);
  exif.writeUInt32BE(8, 4);
  exif.writeUInt16BE(1, 8);
  exif.writeUInt16BE(0x0112, 10);
  exif.writeUInt16BE(3, 12);
  exif.writeUInt32BE(1, 14);
  exif.writeUInt16BE(orientation, 18);
  return exif;
}

test('an EXIF orientation is not applied: the stored geometry stays and the tag is gone', async () => {
  const rotated = withChunksAfterHeader(await pngOf(pixelsOf(6, 2, () => SLATE)), [
    pngChunk('eXIf', exifWithOrientation(6)),
  ]);
  assert.equal((await sharp(rotated).metadata()).orientation, 6, 'the fixture carries the tag');
  const encoded = await encodeImage(rotated, boxed(6, 2, 'inside'), MAX_PIXELS);
  assert.deepEqual([encoded.width, encoded.height], [6, 2]);
  const metadata = await sharp(encoded.bytes).metadata();
  assert.deepEqual([metadata.orientation, metadata.exif], [undefined, undefined]);
});

test('a resize uses the kernel the policy names, lanczos3 by default', async () => {
  const checker = pixelsOf(8, 8, (column, row) =>
    (column + row) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
  );
  const png = await pngOf(checker);
  const encoded = await encodeImage(png, boxed(5, 5, 'inside'), MAX_PIXELS);
  const resizedWith = async (kernel: 'lanczos3' | 'cubic'): Promise<Buffer> =>
    (
      await storedPixelsOf(
        await sharp(png).resize({ width: 5, height: 5, fit: 'inside', kernel }).png().toBuffer(),
      )
    ).pixels;
  const decoded = (await storedPixelsOf(encoded.bytes)).pixels;
  assert.ok(decoded.equals(await resizedWith('lanczos3')), 'what lanczos3 gives');
  assert.ok(!decoded.equals(await resizedWith('cubic')), 'not another kernel');
});

test('pixel art resized without a sprite role is smoothed: new in-between values appear', async () => {
  const checker = pixelsOf(8, 8, (column, row) =>
    (column + row) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
  );
  const decoded = await decodedOf(checker, boxed(5, 5, 'inside'));
  const greys = new Set(pixelIndexes(decoded).map((index) => decoded.pixels[index * 4]));
  assert.ok(
    [...greys].some((grey) => grey !== 0 && grey !== 255),
    'not nearest-neighbour',
  );
});
