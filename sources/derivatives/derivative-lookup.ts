import type { DerivativePaths } from '../cache/cache-file-names.ts';
import { readCacheFile } from '../cache/cache-files.ts';
import { PipelineError } from '../errors.ts';
import { probeImage } from '../media/encoding/image-probe.ts';
import type { Dimensions } from '../media/original-conversion.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import { digestOf } from './derivative-files.ts';
import { matchingRecordOf } from './derivative-record.ts';
import type { DerivativeOutput, DerivativeRecord } from './derivative-record.ts';

/** A record is a few hundred bytes; anything far larger at its name is not one. */
const MAX_RECORD_BYTES = 64 * 1024;

/** What a cached derivative must have been made from. */
export interface ExpectedDerivative {
  readonly key: string;
  readonly sourceBytes: number;
  readonly sourceDimensions: Dimensions;
}

/**
 * A usable cached derivative, or none: `absent` when nothing was cached, `unusable` when a record
 * or output is there but cannot be trusted.
 */
export type DerivativeLookup =
  | { readonly state: 'hit'; readonly record: DerivativeRecord; readonly bytes: Uint8Array }
  | { readonly state: 'absent' | 'unusable' };

function isSameSize(left: Dimensions, right: Dimensions): boolean {
  return left.width === right.width && left.height === right.height;
}

/** The record when it was made for exactly the expected key from the expected original. */
async function recordAt(
  path: string,
  expected: ExpectedDerivative,
): Promise<DerivativeRecord | 'absent' | 'unusable'> {
  const file = await readCacheFile(path, MAX_RECORD_BYTES);
  if (file.state !== 'present') return file.state === 'absent' ? 'absent' : 'unusable';
  const record = matchingRecordOf(new TextDecoder().decode(file.bytes), expected.key);
  const isFromExpectedSource =
    record?.sourceBytes === expected.sourceBytes &&
    isSameSize(record.sourceDimensions, expected.sourceDimensions);
  return isFromExpectedSource ? record : 'unusable';
}

/** True when the bytes' own header says the recorded media type and dimensions. */
async function headerMatches(bytes: Uint8Array, output: DerivativeOutput): Promise<boolean> {
  try {
    const facts = await probeImage(bytes);
    return `image/${facts.format}` === output.mediaType && isSameSize(facts, output);
  } catch (error) {
    if (error instanceof PipelineError && error.code === 'INVALID_DATA') return false;
    throw error;
  }
}

/** The output's bytes, only when they hash to the record and their header agrees with it. */
async function recordedOutputAt(
  path: string,
  output: DerivativeOutput,
): Promise<Uint8Array | undefined> {
  const file = await readCacheFile(path, output.bytes);
  if (file.state !== 'present') return undefined;
  const digest = digestOf(file.bytes);
  const isRecorded = digest.sha256 === output.sha256 && digest.bytes === output.bytes;
  return isRecorded && (await headerMatches(file.bytes, output)) ? file.bytes : undefined;
}

/** A missing record with an output already at its name means a run stopped halfway. */
async function lookupWithoutRecord(paths: DerivativePaths): Promise<DerivativeLookup> {
  return (await entryKindAt(paths.output)) === 'absent'
    ? { state: 'absent' }
    : { state: 'unusable' };
}

/**
 * The cached derivative, only when its record was made from exactly the expected key's inputs
 * and original, and its output holds exactly the recorded bytes, hashed and their header read on
 * every use. The record's choice and notices are taken as recorded.
 */
export async function lookUpDerivative(
  paths: DerivativePaths,
  expected: ExpectedDerivative,
): Promise<DerivativeLookup> {
  const record = await recordAt(paths.record, expected);
  if (record === 'absent') return lookupWithoutRecord(paths);
  if (record === 'unusable') return { state: 'unusable' };
  const bytes = await recordedOutputAt(paths.output, record.output);
  return bytes === undefined ? { state: 'unusable' } : { state: 'hit', record, bytes };
}
