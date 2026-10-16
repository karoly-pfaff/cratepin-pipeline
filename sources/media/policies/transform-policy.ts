import { createHash } from 'node:crypto';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import type { MediaProfile, ResizeBox } from '../../config/pipeline-config.ts';
import type { EncoderFingerprint } from '../encoding/encoder-fingerprint.ts';

/**
 * Encoder settings pinned here rather than left to Sharp's defaults, so a changed default can
 * never change output bytes without changing the policy (and with it the derivative key).
 */
const WEBP_EFFORT = 4;
const PNG_COMPRESSION_LEVEL = 9;
const RESIZE_KERNEL = 'lanczos3';

export interface WebpOutput {
  readonly format: 'webp';
  readonly lossless: boolean;
  readonly quality: number;
  readonly alphaQuality: number;
  readonly keepSmaller: boolean;
  readonly effort: number;
  /** Keep the colour values of fully transparent pixels instead of letting the encoder drop them. */
  readonly exact: true;
}

/** The output keeps the source's format, e.g. a resized PNG stays a PNG. */
export interface SameFormatOutput {
  readonly format: 'same';
  readonly pngCompressionLevel: number;
}

/** A configured box with how the image is scaled into it: never enlarged, padded transparently. */
export interface ResizePolicy extends ResizeBox {
  readonly kernel: typeof RESIZE_KERNEL;
  readonly enlarge: false;
  readonly padding: 'transparent';
}

/**
 * How an image is turned into screen output, with every configurable setting and the encoder
 * settings this tool chooses spelled out, so the policy can be part of the derivative cache key.
 * Sharp's other defaults are covered by the Sharp version in the encoder fingerprint; what is
 * fixed in this tool's code (the decoder's strictness, the order of operations) by the transform
 * version, which must be raised whenever that code changes. The colour and metadata rules hold
 * for every re-encoded output; a flexible WebP profile that keeps the untouched original keeps
 * its bytes as they are.
 */
export interface ImagePolicy {
  readonly kind: 'image';
  readonly resize: ResizePolicy | null;
  readonly output: WebpOutput | SameFormatOutput;
  /** Pixels are converted from an embedded colour profile to sRGB; output is untagged sRGB. */
  readonly colour: 'srgb';
  /** Metadata (colour profile, EXIF, text chunks) is not copied to the output. */
  readonly metadata: 'strip';
}

export type TransformPolicy = { readonly kind: 'copy' } | ImagePolicy;

/** The policy a configured profile stands for. */
export function normalizedPolicyOf(profile: MediaProfile): TransformPolicy {
  if (profile.kind === 'copy') return { kind: 'copy' };
  const output: WebpOutput | SameFormatOutput =
    profile.webp === undefined
      ? { format: 'same', pngCompressionLevel: PNG_COMPRESSION_LEVEL }
      : { format: 'webp', ...profile.webp, effort: WEBP_EFFORT, exact: true };
  const resize: ResizePolicy | null =
    profile.resize === undefined
      ? null
      : { ...profile.resize, kernel: RESIZE_KERNEL, enlarge: false, padding: 'transparent' };
  return {
    kind: 'image',
    resize,
    output,
    colour: 'srgb',
    metadata: 'strip',
  };
}

/**
 * The same conversion with the source's format kept: the fallback a flexible WebP profile
 * compares against when it resizes.
 */
export function sameFormatVariantOf(policy: ImagePolicy): ImagePolicy {
  return { ...policy, output: { format: 'same', pngCompressionLevel: PNG_COMPRESSION_LEVEL } };
}

/** JSON with object keys sorted at every level, so equal values always give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const fields = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, field]) => field !== undefined)
    .toSorted(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
  return `{${fields.join(',')}}`;
}

/** Everything a derivative's bytes depend on. */
export interface DerivativeInputs {
  readonly sourceSha256: string;
  readonly policy: TransformPolicy;
  readonly fingerprint: EncoderFingerprint;
}

/**
 * The derivative cache key: SHA-256 of the source hash, the normalized policy and the encoder
 * fingerprint. A changed profile, an override on one asset or another encoder build gives a new
 * key, so a stale derivative is never reused.
 */
export function derivativeKeyOf(inputs: DerivativeInputs): string {
  return createHash('sha256').update(canonicalJson(inputs)).digest('hex');
}
