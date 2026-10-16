import { derivativePathsOf } from '../cache/cache-file-names.ts';
import type { DerivativePaths } from '../cache/cache-file-names.ts';
import { originalPathOf } from '../cache/cache-layout.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { PipelineError } from '../errors.ts';
import type { EncoderFingerprint } from '../media/encoding/encoder-fingerprint.ts';
import { assertConvertible } from '../media/policies/conversion-checks.ts';
import { probeImage } from '../media/encoding/image-probe.ts';
import type { ImageFacts } from '../media/encoding/image-probe.ts';
import { convertImage, convertOriginal } from '../media/original-conversion.ts';
import type { ConvertedImage, ConvertedOriginal, Original } from '../media/original-conversion.ts';
import { assertConversionAllowed } from '../media/policies/special-media.ts';
import { derivativeKeyOf } from '../media/policies/transform-policy.ts';
import type { ImagePolicy, TransformPolicy } from '../media/policies/transform-policy.ts';
import { digestOf, publishDerivativeFile } from './derivative-files.ts';
import { lookUpDerivative } from './derivative-lookup.ts';
import type { DerivativeLookup, ExpectedDerivative } from './derivative-lookup.ts';
import { DERIVATIVE_RECORD_SCHEMA_VERSION, recordTextOf } from './derivative-record.ts';
import type { DerivativeRecord } from './derivative-record.ts';

/**
 * One verified original to turn into output through the derivative cache. The caller holds a use
 * claim on the cache (as a pull does), so no prune runs meanwhile.
 */
export interface CachedConversionRequest {
  readonly layout: CacheLayout;
  /** The original's bytes, with the SHA-256 the lock pins for them. */
  readonly original: Original & { readonly sha256: string };
  readonly policy: TransformPolicy;
  readonly fingerprint: EncoderFingerprint;
  readonly maxImagePixels: number;
}

/**
 * How the output was obtained: `copied` (the copy profile needs no derivative), `reused` (a
 * cached derivative verified), `made` (none was cached) or `remade` (something cached could not
 * be used: a record that is unreadable, made from other inputs or another original, or whose
 * choice and notices cannot follow from it; an output that is not the recorded bytes or whose
 * header disagrees with the record; or an output left without its record).
 */
export type DerivativeUse = 'copied' | 'reused' | 'made' | 'remade';

export interface CachedConversion extends ConvertedOriginal {
  readonly outputSha256: string;
  /** The cache file holding exactly the output's bytes: the derivative, or the original's entry. */
  readonly outputFile: string;
  readonly derivativeUse: DerivativeUse;
}

function assertPinnedBytes(original: CachedConversionRequest['original']): void {
  if (digestOf(original.bytes).sha256 === original.sha256) return;
  throw new PipelineError(
    'INTEGRITY_MISMATCH',
    'The original does not have the SHA-256 it was given with; nothing was converted.',
    { sha256: original.sha256 },
  );
}

/**
 * Every check a conversion makes before decoding, made before the lookup too: the media type and
 * role, then format, animation, the pixel limit and what WebP can store. None of them is part of
 * the key, so a warm cache refuses exactly what a cold one does.
 */
async function assertConvertibleBeforeLookup(
  { original, maxImagePixels }: CachedConversionRequest,
  policy: ImagePolicy,
): Promise<ImageFacts> {
  await assertConversionAllowed(original, policy);
  const facts = await probeImage(original.bytes);
  assertConvertible(facts, policy, maxImagePixels);
  return facts;
}

function reusedResult(
  { record, bytes }: Extract<DerivativeLookup, { state: 'hit' }>,
  outputFile: string,
): CachedConversion {
  const { output, sourceBytes } = record;
  return {
    bytes,
    mediaType: output.mediaType,
    dimensions: { width: output.width, height: output.height },
    sourceDimensions: record.sourceDimensions,
    choice: record.choice,
    sourceBytes,
    outputBytes: output.bytes,
    savedBytes: sourceBytes - output.bytes,
    notices: record.notices,
    outputSha256: output.sha256,
    outputFile,
    derivativeUse: 'reused',
  };
}

/** A freshly converted image and what it was made from. */
interface MadeDerivative {
  readonly key: string;
  readonly request: CachedConversionRequest;
  readonly policy: ImagePolicy;
  readonly image: ConvertedImage;
}

function recordOf({ key, request, policy, image }: MadeDerivative): DerivativeRecord {
  return {
    schemaVersion: DERIVATIVE_RECORD_SCHEMA_VERSION,
    key,
    sourceSha256: request.original.sha256,
    sourceBytes: image.sourceBytes,
    sourceDimensions: image.sourceDimensions,
    policy,
    fingerprint: request.fingerprint,
    choice: image.choice,
    output: { ...digestOf(image.bytes), mediaType: image.mediaType, ...image.dimensions },
    notices: image.notices,
  };
}

/** Publishes the output first and the record last, so a record never names missing bytes. */
async function storeDerivative(paths: DerivativePaths, made: MadeDerivative): Promise<string> {
  const { layout } = made.request;
  const record = recordOf(made);
  const file = { layout, key: made.key };
  await publishDerivativeFile({ ...file, path: paths.output }, made.image.bytes);
  await publishDerivativeFile({ ...file, path: paths.record }, Buffer.from(recordTextOf(record)));
  return record.output.sha256;
}

/** The derivative's key, where its files are, and what a cached one must have been made from. */
function derivativeLocationOf(
  { layout, original, fingerprint }: CachedConversionRequest,
  policy: ImagePolicy,
  source: ImageFacts,
): {
  readonly key: string;
  readonly paths: DerivativePaths;
  readonly expected: ExpectedDerivative;
} {
  const key = derivativeKeyOf({ sourceSha256: original.sha256, policy, fingerprint });
  const sourceDimensions = { width: source.width, height: source.height };
  return {
    key,
    paths: derivativePathsOf(layout, original.sha256, key),
    expected: { key, sourceBytes: original.bytes.length, sourceDimensions },
  };
}

async function convertImageWithCache(
  request: CachedConversionRequest,
  policy: ImagePolicy,
): Promise<CachedConversion> {
  const { original, maxImagePixels } = request;
  const facts = await assertConvertibleBeforeLookup(request, policy);
  const { key, paths, expected } = derivativeLocationOf(request, policy, facts);
  const lookup = await lookUpDerivative(paths, expected);
  if (lookup.state === 'hit') return reusedResult(lookup, paths.output);
  const image = await convertImage(original, policy, maxImagePixels);
  const outputSha256 = await storeDerivative(paths, { key, request, policy, image });
  return {
    ...image,
    outputSha256,
    outputFile: paths.output,
    derivativeUse: lookup.state === 'absent' ? 'made' : 'remade',
  };
}

/**
 * Converts one verified original through the derivative cache. Every check made before decoding
 * runs first, as none is part of the key. A cached derivative is reused only when its record was
 * made from exactly this source, policy and encoder fingerprint and its output holds exactly the
 * recorded bytes, with the recorded format and dimensions; anything else is converted again and
 * replaces what was cached (a corrupt file is quarantined, never served).
 */
export async function convertWithCache(
  request: CachedConversionRequest,
): Promise<CachedConversion> {
  const { layout, original, policy, maxImagePixels } = request;
  assertPinnedBytes(original);
  if (policy.kind === 'image') return convertImageWithCache(request, policy);
  const copied = await convertOriginal(original, policy, maxImagePixels);
  const outputFile = originalPathOf(layout, original.sha256);
  return { ...copied, outputSha256: original.sha256, outputFile, derivativeUse: 'copied' };
}

/**
 * The cached conversion of an image when it can be reused as is, after the same checks and the
 * same lookup as `convertWithCache`; `undefined` when a build would convert. Nothing is
 * converted, written or quarantined, so a dry run can ask.
 */
export async function findCachedConversion(
  request: CachedConversionRequest,
  policy: ImagePolicy,
): Promise<CachedConversion | undefined> {
  assertPinnedBytes(request.original);
  const facts = await assertConvertibleBeforeLookup(request, policy);
  const { paths, expected } = derivativeLocationOf(request, policy, facts);
  const lookup = await lookUpDerivative(paths, expected);
  return lookup.state === 'hit' ? reusedResult(lookup, paths.output) : undefined;
}
