import { readCacheFile } from '../../cache/cache-files.ts';
import { originalPathOf } from '../../cache/cache-layout.ts';
import type { CacheLayout } from '../../cache/cache-layout.ts';
import { convertWithCache } from '../../derivatives/cached-conversion.ts';
import type {
  CachedConversion,
  CachedConversionRequest,
} from '../../derivatives/cached-conversion.ts';
import { PipelineError, throwIfCancelled } from '../../errors.ts';
import type { SourceRecord } from '../../lock/source-lock.ts';
import type { EncoderFingerprint } from '../../media/encoding/encoder-fingerprint.ts';
import { mediaFailure } from '../../media/media-failures.ts';
import type { ImagePolicy } from '../../media/policies/transform-policy.ts';
import { outputPathOf } from '../../output/layout/output-paths.ts';
import type { ReportIssue } from '../../report.ts';
import { concurrencyGate, mapBounded } from '../../storage/transfer/bounded-tasks.ts';
import type { ConcurrencyGate } from '../../storage/transfer/bounded-tasks.ts';
import type { PlannedAsset } from '../planning/build-plan.ts';

/** How one output was made, without its bytes: those stay in the cache file it names. */
export type OutputConversion = Omit<CachedConversion, 'bytes'>;

/** One asset whose output is made and verified in the cache, ready to be staged. */
export interface BuiltAsset {
  readonly record: SourceRecord;
  readonly profileName: string;
  /** Where the output goes inside the output tree. */
  readonly outputPath: string;
  readonly conversion: OutputConversion;
}

/** Everything the conversion phase needs; every original is already a verified cache entry. */
export interface AssetBuilding {
  readonly layout: CacheLayout;
  readonly assets: readonly PlannedAsset[];
  readonly fingerprint: EncoderFingerprint;
  readonly maxImagePixels: number;
  readonly concurrency: number;
  /** Lets at most `limits.imageConcurrency` originals be read and converted at once. */
  readonly imageGate: ConcurrencyGate;
  readonly signal?: AbortSignal | undefined;
}

export interface BuiltAssets {
  readonly built: readonly BuiltAsset[];
  /** One per asset that could not be converted, at its source path; empty when all were built. */
  readonly issues: readonly ReportIssue[];
}

/** A copy is the original's cache entry itself: nothing to read, convert or store. */
export function copiedOutput(layout: CacheLayout, record: SourceRecord): OutputConversion {
  return {
    mediaType: record.mediaType,
    choice: 'copied',
    sourceBytes: record.bytes,
    outputBytes: record.bytes,
    savedBytes: 0,
    notices: [],
    outputSha256: record.sha256,
    outputFile: originalPathOf(layout, record.sha256),
    derivativeUse: 'copied',
  };
}

/**
 * The largest original a conversion reads: Node reads a file into one buffer of at most 2 GiB - 1
 * bytes. A larger image can still be published with the copy profile, which never reads it.
 */
export const MAX_IMAGE_READ_BYTES = 2 ** 31 - 1;

/** The original was verified, then changed in the cache (or left it) while the build ran. */
function originalGoneOrChanged(record: SourceRecord, hasChanged: boolean): PipelineError {
  const details = { sha256: record.sha256 };
  if (hasChanged) {
    const message = 'The original changed in the cache during the build; build again.';
    return new PipelineError('INTEGRITY_MISMATCH', message, details);
  }
  const message = 'The original left the cache during the build; build again.';
  return new PipelineError('NOT_FOUND', message, details);
}

async function originalBytesOf(layout: CacheLayout, record: SourceRecord): Promise<Uint8Array> {
  if (record.bytes > MAX_IMAGE_READ_BYTES) {
    const message = `The original has ${String(record.bytes)} bytes, more than a conversion can read (${String(MAX_IMAGE_READ_BYTES)}); give it the copy profile.`;
    throw mediaFailure('IMAGE_TOO_LARGE', message, { bytes: record.bytes });
  }
  const entry = await readCacheFile(originalPathOf(layout, record.sha256), record.bytes);
  if (entry.state === 'present') return entry.bytes;
  throw originalGoneOrChanged(record, entry.state === 'corrupt');
}

/** The conversion's facts; its bytes stay in the cache file, as holding every output would not scale. */
export function withoutBytes(conversion: CachedConversion): OutputConversion {
  const { mediaType, choice, sourceBytes, outputBytes, savedBytes, notices } = conversion;
  const { outputSha256, outputFile, derivativeUse, dimensions, sourceDimensions } = conversion;
  return {
    mediaType,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(sourceDimensions === undefined ? {} : { sourceDimensions }),
    choice,
    sourceBytes,
    outputBytes,
    savedBytes,
    notices,
    outputSha256,
    outputFile,
    derivativeUse,
  };
}

/** The derivative cache's request for one asset, with its original's verified bytes. */
export async function conversionRequestOf(
  building: AssetBuilding,
  record: SourceRecord,
  policy: ImagePolicy,
): Promise<CachedConversionRequest> {
  const { layout, fingerprint, maxImagePixels } = building;
  const bytes = await originalBytesOf(layout, record);
  const { mediaType, role, sha256 } = record;
  const original = { bytes, mediaType, sha256, ...(role === undefined ? {} : { role }) };
  return { layout, original, policy, fingerprint, maxImagePixels };
}

async function convertedOutput(
  building: AssetBuilding,
  record: SourceRecord,
  policy: ImagePolicy,
): Promise<OutputConversion> {
  return building.imageGate(async () => {
    // An asset that waited for its place must not start converting after a cancellation.
    throwIfCancelled(building.signal);
    const request = await conversionRequestOf(building, record, policy);
    return withoutBytes(await convertWithCache(request));
  });
}

/**
 * A conversion that failed for this asset's own reason (INVALID_DATA: unreadable, refused by its
 * role, too large, an unexpected type) becomes its issue; anything else, such as an original that
 * changed or left the cache during the build, stops the build.
 */
export function issueOrRethrow(record: SourceRecord, error: unknown): ReportIssue {
  const isAssetFailure = error instanceof PipelineError && error.code === 'INVALID_DATA';
  if (!isAssetFailure) throw error;
  const reason = error.details.reason;
  const code = typeof reason === 'string' ? reason : error.code;
  return { path: record.source, code, message: `"${record.id}": ${error.message}` };
}

type AssetOutcome = { readonly built: BuiltAsset } | { readonly issue: ReportIssue };

/**
 * The built asset for a conversion. Its path must be one the plan checked for clashes: an
 * original whose content is another image type than its name says would land elsewhere, so it is
 * refused (OUTPUT_TYPE_UNEXPECTED) instead.
 */
export function builtAssetOf(asset: PlannedAsset, conversion: OutputConversion): BuiltAsset {
  const { record, profile } = asset;
  const outputPath = outputPathOf(record, conversion.mediaType);
  if (asset.possiblePaths.includes(outputPath)) {
    return { record, profileName: profile.name, outputPath, conversion };
  }
  throw new PipelineError(
    'INVALID_DATA',
    `The original's content gives ${conversion.mediaType} output although its name says ${record.mediaType}; rename the source to match its content.`,
    { reason: 'OUTPUT_TYPE_UNEXPECTED', mediaType: conversion.mediaType },
  );
}

async function buildOne(building: AssetBuilding, asset: PlannedAsset): Promise<AssetOutcome> {
  throwIfCancelled(building.signal);
  const { record, profile } = asset;
  try {
    const conversion =
      profile.policy.kind === 'copy'
        ? copiedOutput(building.layout, record)
        : await convertedOutput(building, record, profile.policy);
    return { built: builtAssetOf(asset, conversion) };
  } catch (error) {
    return { issue: issueOrRethrow(record, error) };
  }
}

/**
 * Makes every planned output in the cache, a bounded number at a time: copies are their
 * original's entry, image profiles convert through the derivative cache. Every asset is tried;
 * one that cannot be converted (unreadable, refused by its role, too large) becomes an issue at
 * its source. Nothing is written near the output directory. A local I/O failure or cancellation
 * stops at once.
 */
export async function buildAssetOutputs(building: AssetBuilding): Promise<BuiltAssets> {
  const outcomes = await mapBounded(building.assets, building.concurrency, (asset) =>
    buildOne(building, asset),
  );
  return {
    built: outcomes.flatMap((outcome) => ('built' in outcome ? [outcome.built] : [])),
    issues: outcomes.flatMap((outcome) => ('issue' in outcome ? [outcome.issue] : [])),
  };
}

/** The gate for image conversions: `limits.imageConcurrency`, never more than `concurrency`. */
export function imageGateFor(imageConcurrency: number, concurrency: number): ConcurrencyGate {
  return concurrencyGate(Math.min(imageConcurrency, concurrency));
}
