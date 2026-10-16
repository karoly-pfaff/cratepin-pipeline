import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { defaultConfig } from '../../config/pipeline-config.ts';
import type { PipelineConfig, WebpEncoding } from '../../config/pipeline-config.ts';
import { PipelineError } from '../../errors.ts';
import {
  animatedPng,
  animationFrameCounts,
  displayP3Png,
  gradientBackgroundPng,
  headerOnlyPng,
  paletteNoisePng,
  pngOf,
  sixteenBitPng,
  storedPixelsOf,
} from '../testing/media-fixtures.test-support.ts';
import { convertOriginal } from '../original-conversion.ts';
import type { Original } from '../original-conversion.ts';
import { profileSelectorFor } from './profile-selection.ts';
import { assertConversionAllowed } from './special-media.ts';
import { normalizedPolicyOf } from './transform-policy.ts';
import type { ImagePolicy } from './transform-policy.ts';

const MAX_PIXELS = 16_383 * 16_383;
const LOSSLESS: WebpEncoding = {
  lossless: true,
  quality: 80,
  alphaQuality: 100,
  keepSmaller: false,
};
/** The image policy of a profile; the test profiles here are all image profiles. */
function imagePolicyOf(profile: Parameters<typeof normalizedPolicyOf>[0]): ImagePolicy {
  return normalizedPolicyOf(profile) as ImagePolicy;
}

const LOSSLESS_WEBP = imagePolicyOf({ kind: 'image', webp: LOSSLESS });
const LOSSY_WEBP = imagePolicyOf({ kind: 'image', webp: { ...LOSSLESS, lossless: false } });
const ACTOR_BOX = imagePolicyOf({
  kind: 'image',
  resize: { width: 512, height: 512, fit: 'contain' },
});
const COPY = { kind: 'copy' } as const;

function refusedBecause(reason: string, details: Record<string, string> = {}) {
  return (error: unknown): boolean =>
    error instanceof PipelineError &&
    error.code === 'INVALID_DATA' &&
    error.details.reason === reason &&
    Object.entries(details).every(([key, value]) => error.details[key] === value) &&
    error.message.includes('copy profile');
}

async function assertCopiedExactly(original: Original): Promise<void> {
  const copied = await convertOriginal(original, COPY, MAX_PIXELS);
  assert.equal(copied.choice, 'copied');
  assert.ok(Buffer.from(copied.bytes).equals(original.bytes), original.mediaType);
  assert.equal(copied.savedBytes, 0);
}

const CELL = 16;
const CELL_COLOURS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
] as const;

/** A colour no reader shows, kept under fully transparent pixels: an exact copy keeps it. */
const HIDDEN = [9, 8, 7, 0];

/** One cell's `size`×`size` square from `start`, in `colour`, written into the sheet. */
function fillSquare(
  sheet: { pixels: Buffer; width: number },
  at: { cell: number; start: number; size: number },
  colour: readonly number[],
): void {
  for (let row = at.start; row < at.start + at.size; row += 1) {
    const rowStart = (row * sheet.width + at.cell * CELL + at.start) * 4;
    sheet.pixels.set(Array.from({ length: at.size }, () => colour).flat(), rowStart);
  }
}

/**
 * Four 16×16 cells side by side, each a coloured 8×8 square in a half-transparent 10×10 ring,
 * inside a transparent margin that hides a colour.
 */
function spriteSheet(): { pixels: Buffer; width: number; height: number } {
  const width = CELL * CELL_COLOURS.length;
  const pixels = Buffer.from(Array.from({ length: width * CELL }, () => HIDDEN).flat());
  const sheet = { pixels, width };
  for (const [cell, colour] of CELL_COLOURS.entries()) {
    fillSquare(sheet, { cell, start: 3, size: 10 }, [...colour, 128]);
    fillSquare(sheet, { cell, start: 4, size: 8 }, [...colour, 255]);
  }
  return { pixels, width, height: CELL };
}

test('a sprite sheet stored as lossless WebP keeps every cell at its coordinates', async () => {
  const sheet = spriteSheet();
  const sprite: Original = { bytes: await pngOf(sheet), mediaType: 'image/png', role: 'sprite' };
  const converted = await convertOriginal(sprite, LOSSLESS_WEBP, MAX_PIXELS);
  const decoded = await storedPixelsOf(converted.bytes);
  assert.deepEqual([decoded.width, decoded.height], [sheet.width, sheet.height]);
  assert.ok(decoded.pixels.equals(sheet.pixels), 'every sample: hidden colour, ring and cells');
  for (const [cell, colour] of CELL_COLOURS.entries()) {
    const centre = (8 * sheet.width + cell * CELL + 8) * 4;
    assert.deepEqual([...decoded.pixels.subarray(centre, centre + 4)], [...colour, 255]);
  }
  await assertCopiedExactly(sprite);
});

test('sprite, atlas, mask and data roles accept only lossless WebP without a resize', async () => {
  const bytes = await pngOf(spriteSheet());
  const refused = [
    { policy: ACTOR_BOX, changes: 'RESIZE,NOT_LOSSLESS_WEBP' },
    { policy: LOSSY_WEBP, changes: 'NOT_LOSSLESS_WEBP' },
  ];
  for (const role of ['sprite', 'atlas', 'mask', 'data']) {
    for (const { policy, changes } of refused) {
      await assert.rejects(
        convertOriginal({ bytes, mediaType: 'image/png', role }, policy, MAX_PIXELS),
        refusedBecause('ROLE_NEEDS_EXACT_PIXELS', { role, changes }),
      );
    }
  }
});

test('atlas, mask and data roles keep 8-bit grey and colour samples exactly', async () => {
  const grey = Buffer.from(Array.from({ length: 16 }, (_, index) => index * 16));
  const greyMask = await sharp(grey, { raw: { width: 4, height: 4, channels: 1 } })
    .png()
    .toBuffer();
  const sheet = await pngOf(spriteSheet());
  for (const [role, bytes] of [
    ['mask', greyMask],
    ['atlas', sheet],
    ['data', sheet],
  ] as const) {
    const converted = await convertOriginal(
      { bytes, mediaType: 'image/png', role },
      LOSSLESS_WEBP,
      MAX_PIXELS,
    );
    assert.equal(converted.mediaType, 'image/webp', role);
    const decoded = await storedPixelsOf(converted.bytes);
    assert.ok(decoded.pixels.equals((await storedPixelsOf(bytes)).pixels), `${role}: every sample`);
  }
  const stored = await convertOriginal(
    { bytes: greyMask, mediaType: 'image/png', role: 'mask' },
    LOSSLESS_WEBP,
    MAX_PIXELS,
  );
  const firstChannel = await sharp(stored.bytes).extractChannel(0).raw().toBuffer();
  assert.ok(firstChannel.equals(grey), 'every grey value as it was');
});

test('only a profile at fault is offered another profile as the remedy', async () => {
  const sprite: Original = {
    bytes: await pngOf(spriteSheet()),
    mediaType: 'image/png',
    role: 'sprite',
  };
  await assert.rejects(
    convertOriginal(sprite, LOSSY_WEBP, MAX_PIXELS),
    /use lossless WebP without a resize/u,
  );
  const tagged: Original = { bytes: await displayP3Png(), mediaType: 'image/png', role: 'sprite' };
  await assert.rejects(
    convertOriginal(tagged, LOSSY_WEBP, MAX_PIXELS),
    (error: unknown) =>
      error instanceof PipelineError && !error.message.includes('use lossless WebP'),
  );
});

test('for exact-pixel roles another format or an animation is refused for its own reason', async () => {
  const jpeg = await sharp(await gradientBackgroundPng())
    .jpeg()
    .toBuffer();
  const animation = animatedPng([await pngOf(spriteSheet()), await pngOf(spriteSheet())]);
  const cases = [
    { bytes: jpeg, mediaType: 'image/jpeg', reason: 'UNSUPPORTED_IMAGE_FORMAT' },
    { bytes: animation, mediaType: 'image/png', reason: 'ANIMATION_UNSUPPORTED' },
  ];
  for (const { bytes, mediaType, reason } of cases) {
    await assert.rejects(
      convertOriginal({ bytes, mediaType, role: 'sprite' }, LOSSY_WEBP, MAX_PIXELS),
      refusedBecause(reason),
    );
  }
});

test('the check stands on its own: it passes what may be converted and refuses without encoding', async () => {
  const bytes = await pngOf(spriteSheet());
  await assertConversionAllowed({ bytes, mediaType: 'image/png' }, LOSSY_WEBP);
  await assertConversionAllowed({ bytes, mediaType: 'image/png', role: 'actor' }, ACTOR_BOX);
  await assertConversionAllowed({ bytes, mediaType: 'image/png', role: 'sprite' }, LOSSLESS_WEBP);
  const hugeHeader = headerOnlyPng(20_000, 20_000);
  await assertConversionAllowed({ bytes: hugeHeader, mediaType: 'image/png' }, LOSSY_WEBP);
  await assert.rejects(
    assertConversionAllowed({ bytes: hugeHeader, mediaType: 'image/png', role: 'mask' }, ACTOR_BOX),
    refusedBecause('ROLE_NEEDS_EXACT_PIXELS', { changes: 'RESIZE,NOT_LOSSLESS_WEBP' }),
  );
  await assert.rejects(
    assertConversionAllowed({ bytes, mediaType: 'audio/ogg' }, LOSSLESS_WEBP),
    refusedBecause('MEDIA_NOT_IMAGE'),
  );
  await assert.rejects(
    assertConversionAllowed({ bytes, mediaType: 'image/png', role: 'print-master' }, LOSSLESS_WEBP),
    refusedBecause('ROLE_NEEDS_COPY'),
  );
});

test('an exact-pixel role refuses what the conversion would change, naming every change', async () => {
  const taggedSixteenBit = await sharp(await sixteenBitPng())
    .withIccProfile('p3')
    .toColourspace('rgb16')
    .png()
    .toBuffer();
  const oneBit = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
    .toColourspace('b-w')
    .png({ palette: false, colours: 2 })
    .toBuffer();
  const cases = [
    { bytes: await displayP3Png(), changes: 'COLOUR_PROFILE' },
    { bytes: await sixteenBitPng(), changes: 'HIGH_PRECISION' },
    { bytes: taggedSixteenBit, changes: 'COLOUR_PROFILE,HIGH_PRECISION' },
    { bytes: await paletteNoisePng(), changes: 'PALETTE' },
    { bytes: oneBit, changes: 'LOW_BIT_DEPTH' },
  ];
  for (const { bytes, changes } of cases) {
    const mask: Original = { bytes, mediaType: 'image/png', role: 'mask' };
    await assert.rejects(
      convertOriginal(mask, LOSSLESS_WEBP, MAX_PIXELS),
      refusedBecause('ROLE_NEEDS_EXACT_PIXELS', { changes }),
    );
    await assertCopiedExactly(mask);
  }
});

test('an exact-pixel refusal reads only the header, before any pixel is decoded', async () => {
  const hugeSixteenBit: Original = {
    bytes: headerOnlyPng(20_000, 20_000, 16),
    mediaType: 'image/png',
    role: 'atlas',
  };
  await assert.rejects(
    convertOriginal(hugeSixteenBit, LOSSLESS_WEBP, 1),
    refusedBecause('ROLE_NEEDS_EXACT_PIXELS', { changes: 'HIGH_PRECISION' }),
    'neither unreadable nor too large: no pixel data was needed',
  );
});

/** One opaque 4×4 animation frame of a single grey, so no two frames can be merged. */
function greyFrame(grey: number): Buffer {
  return Buffer.from(Array.from({ length: 16 }, () => [grey, grey, grey, 255]).flat());
}

const FRAME_COUNT = 3;
const FRAME_PIXELS = Array.from({ length: FRAME_COUNT }, (_, index) => greyFrame(index * 100));
const STACKED_FRAMES = { width: 4, height: 4 * FRAME_COUNT, channels: 4 as const, pageHeight: 4 };

test('animated PNG, GIF and WebP pass through the copy profile and are refused by image profiles', async () => {
  const frameRaw = { width: 4, height: 4, channels: 4 as const };
  const pngFrames = await Promise.all(
    FRAME_PIXELS.map((pixels) => sharp(pixels, { raw: frameRaw }).png().toBuffer()),
  );
  const apng = animatedPng(pngFrames);
  assert.deepEqual(animationFrameCounts(apng), { announced: FRAME_COUNT, controls: FRAME_COUNT });
  const stacked = sharp(Buffer.concat(FRAME_PIXELS), { raw: STACKED_FRAMES });
  const gif = await stacked.clone().gif().toBuffer();
  const webp = await stacked
    .clone()
    .webp({ loop: 0, delay: [100, 100, 100] })
    .toBuffer();
  for (const image of [gif, webp]) {
    assert.equal((await sharp(image).metadata()).pages, FRAME_COUNT, 'a real multi-frame fixture');
  }
  const animations: Original[] = [
    { bytes: apng, mediaType: 'image/png' },
    { bytes: gif, mediaType: 'image/gif' },
    { bytes: webp, mediaType: 'image/webp' },
  ];
  for (const animation of animations) {
    await assertCopiedExactly(animation);
    await assert.rejects(
      convertOriginal(animation, LOSSLESS_WEBP, MAX_PIXELS),
      refusedBecause('ANIMATION_UNSUPPORTED'),
    );
  }
});

/** Just enough of each container's header to look like the real thing. */
const AUDIO: readonly Original[] = [
  {
    bytes: Buffer.concat([Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1'), Buffer.alloc(40, 7)]),
    mediaType: 'audio/wav',
  },
  {
    bytes: Buffer.concat([Buffer.from('OggS\0\x02', 'latin1'), Buffer.alloc(40, 3)]),
    mediaType: 'audio/ogg',
  },
  {
    bytes: Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]),
      Buffer.alloc(40, 1),
    ]),
    mediaType: 'audio/mpeg',
  },
];

test('voice, effects and music stay byte for byte; an image profile never reads them', async () => {
  for (const audio of AUDIO) {
    await assertCopiedExactly(audio);
    await assert.rejects(
      convertOriginal(audio, LOSSLESS_WEBP, MAX_PIXELS),
      refusedBecause('MEDIA_NOT_IMAGE', { mediaType: audio.mediaType }),
    );
  }
});

test('already compressed images are copied unchanged and never re-encoded', async () => {
  const opaque = await gradientBackgroundPng();
  const compressed: Original[] = [
    { bytes: await sharp(opaque).jpeg({ quality: 70 }).toBuffer(), mediaType: 'image/jpeg' },
    { bytes: await sharp(opaque).webp({ quality: 70 }).toBuffer(), mediaType: 'image/webp' },
  ];
  for (const image of compressed) {
    await assertCopiedExactly(image);
    await assert.rejects(
      convertOriginal(image, LOSSY_WEBP, MAX_PIXELS),
      refusedBecause('UNSUPPORTED_IMAGE_FORMAT'),
    );
  }
});

const PRINT_CONFIG: PipelineConfig = {
  ...defaultConfig(),
  profiles: {
    'actor-512': { kind: 'image', resize: { width: 512, height: 512, fit: 'contain' } },
    artwork: { kind: 'image', webp: LOSSLESS },
  },
  profileRules: [{ match: 'scenes/**/*.png', profile: 'actor-512' }],
  defaultProfile: 'copy',
};

test('a print master keeps its pinned full-resolution bytes; a screen profile never replaces it', async () => {
  const master = await sharp(await displayP3Png())
    .resize(1600, 1200, { fit: 'fill' })
    .withIccProfile('p3')
    .png()
    .toBuffer();
  const select = profileSelectorFor(PRINT_CONFIG);
  const printSource = 'scenes/book/page-1.png';
  const print: Original = { bytes: master, mediaType: 'image/png', role: 'print-master' };
  for (const profile of [undefined, 'artwork']) {
    const { policy } = select({
      source: printSource,
      ...(profile === undefined ? {} : { profile }),
    });
    await assert.rejects(
      convertOriginal(print, policy, MAX_PIXELS),
      refusedBecause('ROLE_NEEDS_COPY', { role: 'print-master' }),
    );
  }
  const pinnedCopy = select({ source: printSource, profile: 'copy' });
  const kept = await convertOriginal(print, pinnedCopy.policy, MAX_PIXELS);
  assert.ok(Buffer.from(kept.bytes).equals(master), 'the master, colour profile and all');
  const size = await sharp(kept.bytes).metadata();
  assert.deepEqual([size.width, size.height, size.icc !== undefined], [1600, 1200, true]);
  const screen = await convertOriginal(
    { bytes: master, mediaType: 'image/png', role: 'background' },
    select({ source: 'scenes/book/cover.png' }).policy,
    MAX_PIXELS,
  );
  assert.deepEqual(
    [screen.choice, (await sharp(screen.bytes).metadata()).width],
    ['converted', 512],
  );
});
