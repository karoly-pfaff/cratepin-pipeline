import { assertConvertible } from '../policies/conversion-checks.ts';
import { probeImage } from './image-probe.ts';
import type { ImageFacts } from './image-probe.ts';
import { convertStreaming } from './pixel-stages.ts';
import type { ImagePolicy } from '../policies/transform-policy.ts';

const MEDIA_TYPES = { png: 'image/png', webp: 'image/webp' } as const;

type OutputFormat = keyof typeof MEDIA_TYPES;

/** Something about the output a reader should know, though nothing failed. */
export interface MediaNotice {
  readonly code: 'COLOUR_CONVERTED' | 'PRECISION_REDUCED';
  readonly message: string;
}

export interface EncodedImage {
  readonly bytes: Uint8Array;
  readonly format: OutputFormat;
  readonly mediaType: (typeof MEDIA_TYPES)[OutputFormat];
  readonly width: number;
  readonly height: number;
  readonly source: ImageFacts;
  readonly notices: readonly MediaNotice[];
}

function noticesFor(facts: ImageFacts): MediaNotice[] {
  const notices: MediaNotice[] = [];
  if (facts.hasColourProfile) {
    notices.push({
      code: 'COLOUR_CONVERTED',
      message:
        'The original has a colour profile; its pixels were converted to untagged sRGB, so stored values can differ while sRGB screens show the same colours.',
    });
  }
  if (facts.bitsPerSample > 8) {
    notices.push({
      code: 'PRECISION_REDUCED',
      message: `The original has ${String(facts.bitsPerSample)} bits per sample; the output keeps 8.`,
    });
  }
  return notices;
}

function isOutputFormat(format: string): format is OutputFormat {
  return Object.hasOwn(MEDIA_TYPES, format);
}

/**
 * Converts one verified PNG original as `policy` says. Lossless output keeps every alpha value
 * and, unless a resize scales the image, the colour of fully transparent pixels (a scaling
 * resize clears it to 0,0,0,0); geometry changes only by an explicit resize; pixels are converted
 * to sRGB from an embedded colour profile, and metadata is dropped. Animated and non-PNG images
 * are refused rather than flattened; the pixel limit and what WebP can store are checked on the
 * header before any pixel is decoded. It checks neither the media type nor the role: use
 * `convertOriginal`, or call `assertConversionAllowed` first.
 */
export async function encodeImage(
  bytes: Uint8Array,
  policy: ImagePolicy,
  maxImagePixels: number,
): Promise<EncodedImage> {
  const facts = await probeImage(bytes);
  assertConvertible(facts, policy, maxImagePixels);
  const { encoded, output } = await convertStreaming(bytes, policy, maxImagePixels);
  if (!isOutputFormat(output.format)) throw new Error(`Unexpected encoder output ${output.format}`);
  return {
    bytes: encoded,
    format: output.format,
    mediaType: MEDIA_TYPES[output.format],
    width: output.width,
    height: output.height,
    source: facts,
    notices: noticesFor(facts),
  };
}
