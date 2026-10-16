import { isJsonObject, parseStrictJson } from '../json/strict-json.ts';
import { isSha256Hex } from '../lock/lock-validation.ts';
import type { EncoderFingerprint } from '../media/encoding/encoder-fingerprint.ts';
import type { ConversionNotice, Dimensions } from '../media/original-conversion.ts';
import { derivativeKeyOf } from '../media/policies/transform-policy.ts';
import type { ImagePolicy } from '../media/policies/transform-policy.ts';

export const DERIVATIVE_RECORD_SCHEMA_VERSION = 1;

/** The bytes a derivative's output file must hold, and what they are. */
export interface DerivativeOutput extends Dimensions {
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
}

/**
 * Everything known about one cached derivative: what it was made from (the key's inputs, kept in
 * full so a reader checks them, not just the file name) and what came out.
 */
export interface DerivativeRecord {
  readonly schemaVersion: typeof DERIVATIVE_RECORD_SCHEMA_VERSION;
  readonly key: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly sourceDimensions: Dimensions;
  readonly policy: ImagePolicy;
  readonly fingerprint: EncoderFingerprint;
  readonly choice: 'converted' | 'kept-smaller';
  readonly output: DerivativeOutput;
  readonly notices: readonly ConversionNotice[];
}

const OUTPUT_MEDIA_TYPES: ReadonlySet<unknown> = new Set(['image/png', 'image/webp']);
const CHOICES: ReadonlySet<unknown> = new Set(['converted', 'kept-smaller']);

type Fields = Readonly<Record<string, unknown>>;

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isDimensions(value: unknown): boolean {
  return isJsonObject(value) && isPositiveCount(value.width) && isPositiveCount(value.height);
}

function isOutput(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  const { sha256, bytes, mediaType } = value;
  return (
    isSha256Hex(sha256) &&
    isCount(bytes) &&
    OUTPUT_MEDIA_TYPES.has(mediaType) &&
    isDimensions(value)
  );
}

/** Every notice code a conversion can give. */
const NOTICE_CODES: ReadonlySet<unknown> = new Set([
  'COLOUR_CONVERTED',
  'PRECISION_REDUCED',
  'SIZE_GREW',
  'KEPT_SMALLER_FORMAT',
]);

function isNotice(value: unknown): boolean {
  return isJsonObject(value) && NOTICE_CODES.has(value.code) && typeof value.message === 'string';
}

function describesSource({
  schemaVersion,
  sourceSha256,
  sourceBytes,
  sourceDimensions,
}: Fields): boolean {
  return (
    schemaVersion === DERIVATIVE_RECORD_SCHEMA_VERSION &&
    isSha256Hex(sourceSha256) &&
    isCount(sourceBytes) &&
    isDimensions(sourceDimensions)
  );
}

function isWellFormed(value: Fields): boolean {
  const { choice, output, notices } = value;
  return (
    describesSource(value) &&
    CHOICES.has(choice) &&
    isOutput(output) &&
    Array.isArray(notices) &&
    notices.every(isNotice)
  );
}

/** True when the record's own inputs give `key`: same source, same policy, same encoder. */
function isMadeFor(record: Fields, key: string): boolean {
  if (record.key !== key) return false;
  const inputs = {
    sourceSha256: record.sourceSha256,
    policy: record.policy,
    fingerprint: record.fingerprint,
  } as Parameters<typeof derivativeKeyOf>[0];
  return derivativeKeyOf(inputs) === key;
}

/**
 * True when the record's choice and size notices follow from its own policy and sizes: only a
 * flexible WebP profile keeps a same-format output, and exactly then with KEPT_SMALLER_FORMAT;
 * SIZE_GREW exactly when the output is larger than the original.
 */
function isConsistent({ policy, choice, output, sourceBytes, notices }: DerivativeRecord): boolean {
  const codes = new Set(notices.map(({ code }) => code));
  const isFlexibleWebp = policy.output.format === 'webp' && policy.output.keepSmaller;
  const isKeptSmaller = choice === 'kept-smaller';
  return (
    isKeptSmaller === (isFlexibleWebp && output.mediaType !== 'image/webp') &&
    codes.has('KEPT_SMALLER_FORMAT') === isKeptSmaller &&
    codes.has('SIZE_GREW') === output.bytes > sourceBytes
  );
}

/**
 * The record in `text` when it is well formed and was made from exactly the inputs of `key`;
 * `undefined` for anything else (unreadable, another schema, another source, policy or encoder,
 * or a choice and notices its own policy and sizes cannot give), which is never reused.
 */
export function matchingRecordOf(text: string, key: string): DerivativeRecord | undefined {
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return undefined;
  const fields = parsed.value;
  if (!isWellFormed(fields) || !isMadeFor(fields, key)) return undefined;
  const record = fields as unknown as DerivativeRecord;
  return isConsistent(record) ? record : undefined;
}

/** The record as written to the cache: two-space JSON with a final newline. */
export function recordTextOf(record: DerivativeRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
