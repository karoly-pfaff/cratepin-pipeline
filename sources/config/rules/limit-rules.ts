import { configIssue, fieldIssues, isIntegerBetween } from './field-rules.ts';
import type { FieldRule, RawConfigObject } from './field-rules.ts';
import { MAX_CONCURRENCY, MAX_IMAGE_CONCURRENCY } from '../pipeline-config.ts';
import type { ConfigIssue, PipelineConfig } from '../pipeline-config.ts';

const MEBIBYTE = 1024 * 1024;
/** R2, like S3, needs multipart parts of at least 5 MiB and single requests of at most 5 GiB. */
const MIN_PART_BYTES = 5 * MEBIBYTE;
const MAX_REQUEST_BYTES = 5 * 1024 * MEBIBYTE;
/** A multipart upload has at most 10,000 parts. */
const MAX_PARTS = 10_000;

function bytesRule(key: string, minimum: number, maximum: number): FieldRule {
  return {
    key,
    isValid: isIntegerBetween(minimum, maximum),
    expectation: `Expected an integer ${String(minimum)}–${String(maximum)} (bytes)`,
  };
}

const LIMIT_FIELDS: readonly FieldRule[] = [
  {
    key: 'concurrency',
    isValid: isIntegerBetween(1, MAX_CONCURRENCY),
    expectation: `Expected an integer 1–${String(MAX_CONCURRENCY)}`,
  },
  {
    key: 'imageConcurrency',
    isValid: isIntegerBetween(1, MAX_IMAGE_CONCURRENCY),
    expectation: `Expected an integer 1–${String(MAX_IMAGE_CONCURRENCY)}`,
  },
  bytesRule('maxSourceBytes', 1, Number.MAX_SAFE_INTEGER),
  {
    key: 'maxImagePixels',
    isValid: isIntegerBetween(1, Number.MAX_SAFE_INTEGER),
    expectation: 'Expected a positive integer (pixels)',
  },
  bytesRule('multipartThresholdBytes', MIN_PART_BYTES, MAX_REQUEST_BYTES),
  bytesRule('multipartPartBytes', MIN_PART_BYTES, MAX_REQUEST_BYTES),
  {
    key: 'transferAttempts',
    isValid: isIntegerBetween(1, 10),
    expectation: 'Expected an integer 1–10 (attempts per request, including the first)',
  },
  {
    key: 'requestTimeoutSeconds',
    // Node's HTTP client gives up after 300 s without headers or data on its own anyway.
    isValid: isIntegerBetween(1, 300),
    expectation: 'Expected an integer 1–300 (seconds)',
  },
];

/** Shape issues of the optional `limits` section. */
export function limitSectionIssues(limits: RawConfigObject): ConfigIssue[] {
  return fieldIssues(limits, '/limits', LIMIT_FIELDS);
}

/** The largest accepted original must fit into the allowed number of multipart parts. */
export function limitRelationIssues({ limits }: PipelineConfig): ConfigIssue[] {
  if (Math.ceil(limits.maxSourceBytes / limits.multipartPartBytes) <= MAX_PARTS) return [];
  const message = `maxSourceBytes needs more than ${String(MAX_PARTS)} parts of multipartPartBytes`;
  return [configIssue('/limits/multipartPartBytes', message)];
}
