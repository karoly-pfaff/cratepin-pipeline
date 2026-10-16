import { storedPixelsOf } from './media-fixtures.test-support.ts';
import type { RawImage } from './media-fixtures.test-support.ts';

/**
 * How far a converted image is from its original, measured on decoded RGBA. Colour error is
 * weighted by the original's alpha (a half-transparent pixel's colour shows half), and pixels the
 * original makes fully transparent do not count, as no reader shows their colour.
 */
export interface VisualDifference {
  readonly sameGeometry: boolean;
  /** The largest change of any alpha value. */
  readonly maxAlphaDelta: number;
  /** Fully transparent pixels made visible, plus fully opaque ones made see-through. */
  readonly transparencyFlips: number;
  /** Mean absolute colour error per channel, 0 to 255. */
  readonly meanAbsoluteError: number;
  /** Peak signal-to-noise ratio of the colour, in dB; `Infinity` when identical. */
  readonly psnr: number;
  /** The colour error 99.9 % of channel samples stay at or below. */
  readonly deltaAt999: number;
}

/** Sums of the alpha-weighted colour errors and a histogram of them, over visible pixels. */
class ColourErrors {
  readonly histogram = new Array<number>(256).fill(0);
  absoluteSum = 0;
  squaredSum = 0;
  samples = 0;

  add(error: number): void {
    const rounded = Math.round(error);
    this.histogram[rounded] = (this.histogram[rounded] ?? 0) + 1;
    this.absoluteSum += error;
    this.squaredSum += error * error;
    this.samples += 1;
  }

  /** The smallest error that `share` of all samples stay at or below. */
  quantile(share: number): number {
    let seen = 0;
    const index = this.histogram.findIndex((count) => {
      seen += count;
      return seen >= share * this.samples;
    });
    return Math.max(0, index);
  }
}

/** Alpha changes and transparency flips over all pixels. */
class AlphaChanges {
  maxDelta = 0;
  flips = 0;

  add(before: number, after: number): void {
    this.maxDelta = Math.max(this.maxDelta, Math.abs(before - after));
    const madeVisible = before === 0 && after !== 0;
    const madeSeeThrough = before === 255 && after !== 255;
    if (madeVisible || madeSeeThrough) this.flips += 1;
  }
}

function sampleAt(image: RawImage, offset: number): number {
  return image.pixels[offset] ?? 0;
}

function addPixel(
  at: number,
  images: { before: RawImage; after: RawImage },
  sums: { colour: ColourErrors; alpha: AlphaChanges },
): void {
  const alpha = sampleAt(images.before, at + 3);
  sums.alpha.add(alpha, sampleAt(images.after, at + 3));
  if (alpha === 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const delta = Math.abs(
      sampleAt(images.before, at + channel) - sampleAt(images.after, at + channel),
    );
    sums.colour.add((delta * alpha) / 255);
  }
}

function summaryOf(colour: ColourErrors, alpha: AlphaChanges): VisualDifference {
  const meanSquared = colour.samples === 0 ? 0 : colour.squaredSum / colour.samples;
  return {
    sameGeometry: true,
    maxAlphaDelta: alpha.maxDelta,
    transparencyFlips: alpha.flips,
    meanAbsoluteError: colour.samples === 0 ? 0 : colour.absoluteSum / colour.samples,
    psnr: meanSquared === 0 ? Infinity : 10 * Math.log10((255 * 255) / meanSquared),
    deltaAt999: colour.quantile(0.999),
  };
}

const DIFFERENT_GEOMETRY: VisualDifference = {
  sameGeometry: false,
  maxAlphaDelta: 255,
  transparencyFlips: Infinity,
  meanAbsoluteError: Infinity,
  psnr: 0,
  deltaAt999: 255,
};

/** The visual difference of `output` from `original`, both encoded images of any format. */
export async function visualDifferenceOf(
  original: Uint8Array,
  output: Uint8Array,
): Promise<VisualDifference> {
  const before = await storedPixelsOf(original);
  const after = await storedPixelsOf(output);
  if (before.width !== after.width || before.height !== after.height) return DIFFERENT_GEOMETRY;
  const sums = { colour: new ColourErrors(), alpha: new AlphaChanges() };
  for (let at = 0; at < before.pixels.length; at += 4) addPixel(at, { before, after }, sums);
  return summaryOf(sums.colour, sums.alpha);
}
