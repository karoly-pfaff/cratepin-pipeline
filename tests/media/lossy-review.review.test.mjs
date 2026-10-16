import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { encoderFingerprint } from '../../sources/media/encoding/encoder-fingerprint.ts';
import { encodeImage } from '../../sources/media/encoding/image-encoding.ts';
import { lossyFixtures } from '../../sources/media/testing/lossy-fixtures.test-support.ts';
import { storedPixelsOf } from '../../sources/media/testing/media-fixtures.test-support.ts';
import { normalizedPolicyOf } from '../../sources/media/policies/transform-policy.ts';
import { visualDifferenceOf } from '../../sources/media/testing/visual-comparison.test-support.ts';

// Opt-in: CRATEPIN_VISUAL_REVIEW=<directory> writes, for every lossy fixture at the
// qualities below, the panels a person needs to judge it (original and output over a
// checkerboard, the visible colour difference amplified 8 times, the output's alpha, 4× zooms
// of its edges), their metrics, and `samples.json` with the output hashes and encoder
// fingerprint the review record (sources/media/testing/reviewed-lossy-samples.json) takes. Nothing is
// decided here.

const DIRECTORY = process.env.CRATEPIN_VISUAL_REVIEW;
const QUALITIES = [50, 82];
const MAX_PIXELS = 8192 * 8192;

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkerboard(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const isLight = (Math.floor((index % width) / 8) + Math.floor(index / width / 8)) % 2 === 0;
    pixels.fill(isLight ? 204 : 153, index * 3, index * 3 + 3);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

async function overCheckerboard(image) {
  const { width, height } = await sharp(image).metadata();
  return checkerboard(width, height)
    .composite([{ input: Buffer.from(image) }])
    .png()
    .toBuffer();
}

/**
 * The colour difference as the metrics count it: |original − output| per channel, weighted by
 * the original's alpha and times 8, as an opaque image. Black is no visible change; pixels the
 * original makes fully transparent stay black, as no reader shows their colour.
 */
async function amplifiedDifference(original, output) {
  const before = await storedPixelsOf(original);
  const after = await storedPixelsOf(output);
  const pixels = Buffer.alloc(before.width * before.height * 3);
  for (let index = 0; index < before.width * before.height; index += 1) {
    const weight = before.pixels[index * 4 + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(
        before.pixels[index * 4 + channel] - after.pixels[index * 4 + channel],
      );
      pixels[index * 3 + channel] = Math.min(255, Math.round(delta * weight * 8));
    }
  }
  return sharp(pixels, { raw: { width: before.width, height: before.height, channels: 3 } })
    .png()
    .toBuffer();
}

function alphaAsGrey(output) {
  return sharp(output).ensureAlpha().extractChannel(3).png().toBuffer();
}

/**
 * Where each fixture's edges are, as 32×32 regions: the sprite's soft fade, the scene's red disc
 * against the blue waves and its checker strip. The smooth background has no edge; its middle is
 * shown instead.
 */
const ZOOMS = {
  'smooth-background': { middle: { left: 240, top: 112 } },
  'soft-edged-sprite': { fade: { left: 0, top: 48 } },
  'saturated-scene': { 'disc-edge': { left: 8, top: 40 }, checker: { left: 0, top: 96 } },
};

/** The 32×32 region at `at`, over a checkerboard, enlarged 4× without smoothing. */
async function zoomOf(image, at) {
  const onBoard = await overCheckerboard(
    await sharp(image)
      .extract({ ...at, width: 32, height: 32 })
      .png()
      .toBuffer(),
  );
  return sharp(onBoard).resize({ width: 128, kernel: 'nearest' }).png().toBuffer();
}

async function zoomPanelsOf(fixture, original, output) {
  const panels = {};
  for (const [region, at] of Object.entries(ZOOMS[fixture])) {
    panels[`zoom-${region}-original`] = await zoomOf(original, at);
    panels[`zoom-${region}-output`] = await zoomOf(output, at);
  }
  return panels;
}

async function panelsOf(fixture, original, output) {
  return {
    original: await overCheckerboard(original),
    output: await overCheckerboard(output),
    difference: await amplifiedDifference(original, output),
    alpha: await alphaAsGrey(output),
    ...(await zoomPanelsOf(fixture, original, output)),
  };
}

async function writeSample(name, png, quality) {
  const webp = { lossless: false, quality, alphaQuality: 100, keepSmaller: false };
  const encoded = await encodeImage(png, normalizedPolicyOf({ kind: 'image', webp }), MAX_PIXELS);
  const sample = `${name}-q${String(quality)}`;
  for (const [panel, bytes] of Object.entries(await panelsOf(name, png, encoded.bytes))) {
    await writeFile(join(DIRECTORY, `${sample}-${panel}.png`), bytes);
  }
  await writeFile(join(DIRECTORY, `${sample}.webp`), encoded.bytes);
  const difference = await visualDifferenceOf(png, encoded.bytes);
  return {
    fixture: name,
    quality,
    outputSha256: sha256Of(encoded.bytes),
    sourceBytes: png.length,
    outputBytes: encoded.bytes.length,
    difference,
  };
}

test('lossy review panels', { skip: DIRECTORY === undefined }, async () => {
  await mkdir(DIRECTORY, { recursive: true });
  const samples = [];
  for (const [name, png] of Object.entries(await lossyFixtures())) {
    for (const quality of QUALITIES) samples.push(await writeSample(name, png, quality));
  }
  const record = { fingerprint: encoderFingerprint(), samples };
  await writeFile(join(DIRECTORY, 'samples.json'), `${JSON.stringify(record, null, 2)}\n`);
});
