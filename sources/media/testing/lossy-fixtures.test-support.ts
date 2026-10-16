import { gradientBackgroundPng, pixelsOf, pngOf } from './media-fixtures.test-support.ts';

// Small synthetic pictures that look like the three kinds of art a lossy profile meets: a smooth
// background, a soft-edged character on transparency, and a saturated scene with hard edges.
// Noise is no use here: lossy encoding is meant to lose it.

function clampedByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** A 128×128 disc whose edge fades out over 6 pixels, coloured by a diagonal gradient. */
function softEdgedSpritePng(): Promise<Buffer> {
  const size = 128;
  const art = pixelsOf(size, size, (column, row) => {
    const distance = Math.hypot(column - 63.5, row - 63.5);
    const alpha = clampedByte(((52 - distance) / 6) * 255);
    return [clampedByte(column * 2), clampedByte(row * 2), clampedByte(255 - column - row), alpha];
  });
  return pngOf(art);
}

/** The colour of the saturated scene at one pixel: a red disc on blue waves over a checker strip. */
function sceneColourAt(column: number, row: number): number[] {
  if (row >= 112)
    return (Math.floor(column / 8) + Math.floor(row / 8)) % 2 === 0
      ? [0, 0, 0, 255]
      : [255, 255, 0, 255];
  if (Math.hypot(column - 64, row - 56) < 40) return [230, 20, 30, 255];
  const wave = Math.sin(column / 9) * 40 + Math.sin(row / 7) * 30;
  return [clampedByte(20 + wave), clampedByte(90 + wave), clampedByte(220 - wave), 255];
}

/** A 256×128 saturated scene with hard edges, the hardest case for 4:2:0 lossy colour. */
function saturatedScenePng(): Promise<Buffer> {
  return pngOf(pixelsOf(256, 128, sceneColourAt));
}

/** The three lossy fixtures by name. */
export async function lossyFixtures(): Promise<Record<string, Buffer>> {
  return {
    'smooth-background': await gradientBackgroundPng(),
    'soft-edged-sprite': await softEdgedSpritePng(),
    'saturated-scene': await saturatedScenePng(),
  };
}
