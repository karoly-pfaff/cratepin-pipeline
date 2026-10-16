import { encodeImage } from './encoding/image-encoding.ts';
import type { EncodedImage, MediaNotice } from './encoding/image-encoding.ts';
import { assertConversionAllowed } from './policies/special-media.ts';
import type { MediaTypeAndRole } from './policies/special-media.ts';
import { sameFormatVariantOf } from './policies/transform-policy.ts';
import type { ImagePolicy, TransformPolicy } from './policies/transform-policy.ts';

/** A verified original's bytes with the media type and role the lock records for it. */
export interface Original extends MediaTypeAndRole {
  readonly bytes: Uint8Array;
}

/**
 * What became of an original: `copied` byte for byte, `converted` as the profile says, or
 * `kept-smaller`, where a flexible WebP profile kept a smaller output in the original's format.
 */
export type ConversionChoice = 'copied' | 'converted' | 'kept-smaller';

/** A notice about the output: one about the image's content, or about its size or format. */
export interface ConversionNotice {
  readonly code: MediaNotice['code'] | 'SIZE_GREW' | 'KEPT_SMALLER_FORMAT';
  readonly message: string;
}

/** An image's size in pixels. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface ConvertedOriginal {
  readonly bytes: Uint8Array;
  /** The media type of the bytes actually produced, e.g. `image/png` after a fallback. */
  readonly mediaType: string;
  /** The output's size in pixels; absent for a copy, which is never decoded. */
  readonly dimensions?: Dimensions;
  /** The original's size in pixels; absent for a copy. */
  readonly sourceDimensions?: Dimensions;
  readonly choice: ConversionChoice;
  readonly sourceBytes: number;
  readonly outputBytes: number;
  /** Source minus output bytes; zero or negative when nothing was saved. */
  readonly savedBytes: number;
  readonly notices: readonly ConversionNotice[];
}

/** An original converted by an image profile, whose geometry is therefore always known. */
export interface ConvertedImage extends ConvertedOriginal {
  readonly choice: Exclude<ConversionChoice, 'copied'>;
  readonly dimensions: Dimensions;
  readonly sourceDimensions: Dimensions;
}

/** One possible output of an image conversion, before its size is compared or reported. */
interface Candidate {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly dimensions: Dimensions;
  readonly choice: ConvertedImage['choice'];
  readonly notices: readonly ConversionNotice[];
}

/** One original on its way through an image policy. */
interface ImageConversion {
  readonly original: Original;
  readonly policy: ImagePolicy;
  readonly maxImagePixels: number;
}

/** Any output larger than its original says so: the profile's settings, not this tool, kept it. */
function growthNotices(original: Original, candidate: Candidate): ConversionNotice[] {
  if (candidate.bytes.length <= original.bytes.length) return [];
  return [
    {
      code: 'SIZE_GREW',
      message: `The ${candidate.mediaType} output (${String(candidate.bytes.length)} bytes) is larger than the original (${String(original.bytes.length)} bytes); the profile's settings keep it.`,
    },
  ];
}

/** The measured sizes of an output; savings may be zero or negative. */
function sizesOf(
  original: Original,
  output: Uint8Array,
): Pick<ConvertedOriginal, 'sourceBytes' | 'outputBytes' | 'savedBytes'> {
  const sourceBytes = original.bytes.length;
  return { sourceBytes, outputBytes: output.length, savedBytes: sourceBytes - output.length };
}

function converted({ bytes, mediaType, width, height, notices }: EncodedImage): Candidate {
  return { bytes, mediaType, dimensions: { width, height }, choice: 'converted', notices };
}

/**
 * What a flexible WebP profile compares WebP with, in the original's format: the same resize,
 * and the untouched original (its bytes, colour profile and metadata unchanged) whenever the
 * profile's geometry leaves the image as it is.
 */
async function sameFormatAlternatives(
  { original, policy, maxImagePixels }: ImageConversion,
  webp: EncodedImage,
): Promise<Candidate[]> {
  const untouched: Candidate = {
    bytes: original.bytes,
    mediaType: `image/${webp.source.format}`,
    dimensions: { width: webp.source.width, height: webp.source.height },
    choice: 'kept-smaller',
    notices: [],
  };
  const keepsGeometry = webp.width === webp.source.width && webp.height === webp.source.height;
  if (policy.resize === null) return [untouched];
  const resized = await encodeImage(original.bytes, sameFormatVariantOf(policy), maxImagePixels);
  const resizedCandidate: Candidate = { ...converted(resized), choice: 'kept-smaller' };
  return keepsGeometry ? [untouched, resizedCandidate] : [resizedCandidate];
}

function smallestOf(candidates: readonly Candidate[]): Candidate | undefined {
  return candidates.toSorted((left, right) => left.bytes.length - right.bytes.length)[0];
}

/** WebP is kept only when it is strictly smaller than every same-format alternative. */
async function smallestOutput(conversion: ImageConversion, webp: EncodedImage): Promise<Candidate> {
  const alternative = smallestOf(await sameFormatAlternatives(conversion, webp));
  if (alternative === undefined || webp.bytes.length < alternative.bytes.length) {
    return converted(webp);
  }
  const kept: ConversionNotice = {
    code: 'KEPT_SMALLER_FORMAT',
    message: `WebP (${String(webp.bytes.length)} bytes) was not smaller than ${alternative.mediaType} (${String(alternative.bytes.length)} bytes), so keepSmaller kept ${alternative.mediaType}.`,
  };
  return { ...alternative, notices: [...alternative.notices, kept] };
}

/**
 * Turns one verified original into output bytes with an image profile, and reports the real
 * sizes and geometry. The profile is refused where the media type or role forbids what it would
 * do. A WebP profile with `keepSmaller` keeps the smallest of the WebP and the same-format
 * alternatives, with that output's real media type; a strict WebP profile keeps WebP. Any output
 * larger than the original says so; savings are reported as measured, zero or negative too.
 */
export async function convertImage(
  original: Original,
  policy: ImagePolicy,
  maxImagePixels: number,
): Promise<ConvertedImage> {
  await assertConversionAllowed(original, policy);
  const encoded = await encodeImage(original.bytes, policy, maxImagePixels);
  const isFlexibleWebp = policy.output.format === 'webp' && policy.output.keepSmaller;
  const chosen = isFlexibleWebp
    ? await smallestOutput({ original, policy, maxImagePixels }, encoded)
    : converted(encoded);
  return {
    ...chosen,
    sourceDimensions: { width: encoded.source.width, height: encoded.source.height },
    ...sizesOf(original, chosen.bytes),
    notices: [...chosen.notices, ...growthNotices(original, chosen)],
  };
}

/**
 * Turns one verified original into output bytes as its normalized policy says: the copy profile
 * keeps the bytes (nothing saved, never decoded); an image profile converts (`convertImage`).
 */
export async function convertOriginal(
  original: Original,
  policy: TransformPolicy,
  maxImagePixels: number,
): Promise<ConvertedOriginal> {
  if (policy.kind === 'image') return convertImage(original, policy, maxImagePixels);
  const { bytes, mediaType } = original;
  return { bytes, mediaType, choice: 'copied', ...sizesOf(original, bytes), notices: [] };
}
