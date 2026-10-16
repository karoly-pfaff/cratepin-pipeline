import type { ImageFacts } from '../encoding/image-probe.ts';
import { mediaFailure } from '../media-failures.ts';
import type { ImagePolicy, ResizePolicy } from './transform-policy.ts';

/** Image formats the converter reads; anything else must use the copy profile. */
const CONVERTIBLE_FORMATS = new Set(['png']);
/** libwebp stores at most this many pixels along either edge. */
const MAX_WEBP_EDGE = 16_383;

/** Animated or non-PNG originals keep their bytes only through the copy profile. */
export function assertConvertibleFormat(facts: ImageFacts): void {
  if (facts.isAnimated) {
    throw mediaFailure(
      'ANIMATION_UNSUPPORTED',
      'The image is animated; only the copy profile keeps its frames, so assign that profile.',
      { format: facts.format },
    );
  }
  if (CONVERTIBLE_FORMATS.has(facts.format)) return;
  throw mediaFailure(
    'UNSUPPORTED_IMAGE_FORMAT',
    `Image profiles convert PNG originals only; assign the copy profile to this ${facts.format} file.`,
    { format: facts.format },
  );
}

function assertWithinPixelLimit(
  facts: Pick<ImageFacts, 'width' | 'height'>,
  maxImagePixels: number,
): void {
  if (facts.width * facts.height <= maxImagePixels) return;
  throw mediaFailure(
    'IMAGE_TOO_LARGE',
    `The image has ${String(facts.width)}×${String(facts.height)} pixels, more than limits.maxImagePixels allows; reduce the original or resize box, or raise the limit.`,
    { width: facts.width, height: facts.height, maxImagePixels },
  );
}

/**
 * The output's size: unchanged without a resize; the whole box for `contain` (the image is
 * padded, never enlarged); the image scaled down to fit for `inside`.
 */
function outputSizeOf(
  facts: ImageFacts,
  resize: ResizePolicy | null,
): { readonly width: number; readonly height: number } {
  if (resize === null) return facts;
  if (resize.fit === 'contain') return { width: resize.width, height: resize.height };
  const scale = Math.min(1, resize.width / facts.width, resize.height / facts.height);
  return {
    width: Math.max(1, Math.round(facts.width * scale)),
    height: Math.max(1, Math.round(facts.height * scale)),
  };
}

function assertWebpCanHold(facts: ImageFacts, policy: ImagePolicy): void {
  if (policy.output.format !== 'webp') return;
  const { width, height } = outputSizeOf(facts, policy.resize);
  if (Math.max(width, height) <= MAX_WEBP_EDGE) return;
  throw mediaFailure(
    'WEBP_EDGE_TOO_LONG',
    `WebP stores at most ${String(MAX_WEBP_EDGE)} pixels per edge, and this output would be ${String(width)}×${String(height)}; use a smaller resize box or a profile without WebP.`,
    { width, height },
  );
}

/**
 * Everything checked from the header before any pixel is decoded, in the order that gives the
 * most useful remedy: format and animation first, then source and output pixel limits (before
 * decoding or allocating a padded canvas), then what WebP can store.
 */
export function assertConvertible(
  facts: ImageFacts,
  policy: ImagePolicy,
  maxImagePixels: number,
): void {
  assertConvertibleFormat(facts);
  assertWithinPixelLimit(facts, maxImagePixels);
  assertWithinPixelLimit(outputSizeOf(facts, policy.resize), maxImagePixels);
  assertWebpCanHold(facts, policy);
}
