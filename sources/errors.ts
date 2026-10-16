export type ErrorCode =
  | 'CANCELLED'
  | 'AUTH_FAILED'
  | 'TRANSIENT_TRANSFER'
  | 'INTEGRITY_MISMATCH'
  | 'INVALID_DATA'
  | 'OUTPUT_CONFLICT'
  | 'NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'USAGE'
  | 'NOT_IMPLEMENTED'
  | 'IO_FAILED';

export type ErrorDetails = Readonly<Record<string, string | number | boolean>>;

interface ErrorCodeTraits {
  readonly exitCode: number;
  readonly isRetryable: boolean;
}

/** Exit codes 0–3 predate the full error model and keep their meaning. */
const ERROR_CODE_TRAITS: Readonly<Record<ErrorCode, ErrorCodeTraits>> = {
  IO_FAILED: { exitCode: 1, isRetryable: false },
  CONFIG_INVALID: { exitCode: 2, isRetryable: false },
  NOT_IMPLEMENTED: { exitCode: 3, isRetryable: false },
  USAGE: { exitCode: 4, isRetryable: false },
  AUTH_FAILED: { exitCode: 5, isRetryable: false },
  TRANSIENT_TRANSFER: { exitCode: 6, isRetryable: true },
  INTEGRITY_MISMATCH: { exitCode: 7, isRetryable: false },
  INVALID_DATA: { exitCode: 8, isRetryable: false },
  OUTPUT_CONFLICT: { exitCode: 9, isRetryable: false },
  NOT_FOUND: { exitCode: 10, isRetryable: false },
  CANCELLED: { exitCode: 130, isRetryable: false },
};

const TRANSIENT_NETWORK_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];

const ERROR_CODES_BY_SYSTEM_CODE = new Map<string, ErrorCode>([
  ['ENOENT', 'NOT_FOUND'],
  ['EEXIST', 'OUTPUT_CONFLICT'],
  ['ENOTEMPTY', 'OUTPUT_CONFLICT'],
  ['EBUSY', 'OUTPUT_CONFLICT'],
  ['EISDIR', 'INVALID_DATA'],
  ...TRANSIENT_NETWORK_CODES.map((code): [string, ErrorCode] => [code, 'TRANSIENT_TRANSFER']),
]);

const MESSAGES_BY_ERROR_CODE = new Map<ErrorCode, string>([
  ['TRANSIENT_TRANSFER', 'Network transfer failed; raw error details are suppressed.'],
  ['NOT_FOUND', 'A required file or object does not exist.'],
  ['OUTPUT_CONFLICT', 'The target already exists or is in use.'],
  ['INVALID_DATA', 'Expected a file but found a directory.'],
]);
/** Standard error names thrown by AbortSignal and AbortSignal.timeout(). */
const FAILURES_BY_ERROR_NAME = new Map<string, { code: ErrorCode; message: string }>([
  ['AbortError', { code: 'CANCELLED', message: 'Operation was cancelled.' }],
  ['TimeoutError', { code: 'TRANSIENT_TRANSFER', message: 'Operation timed out.' }],
]);
const GENERIC_FAILURE_MESSAGE = 'Local operation failed; raw error details are suppressed.';

function errorCodeForSystemCode(systemCode: string | undefined): ErrorCode {
  if (systemCode === undefined) return 'IO_FAILED';
  return ERROR_CODES_BY_SYSTEM_CODE.get(systemCode) ?? 'IO_FAILED';
}

export class PipelineError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.details = details;
  }

  get isRetryable(): boolean {
    return ERROR_CODE_TRAITS[this.code].isRetryable;
  }

  get exitCode(): number {
    return ERROR_CODE_TRAITS[this.code].exitCode;
  }
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function stringCodeOf(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The system code of an error or, for `fetch failed` style wrappers, of its cause. */
function systemCodeOf(error: unknown): string | undefined {
  return stringCodeOf(error) ?? stringCodeOf((error as { cause?: unknown } | null)?.cause);
}

/** The error itself if it is a PipelineError, or the one `fetch` wraps when a request body threw. */
function carriedPipelineError(error: unknown): PipelineError | undefined {
  if (error instanceof PipelineError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof PipelineError ? cause : undefined;
}

function classifiedSystemError(error: unknown): PipelineError {
  const systemCode = systemCodeOf(error);
  const code = errorCodeForSystemCode(systemCode);
  const message = MESSAGES_BY_ERROR_CODE.get(code) ?? GENERIC_FAILURE_MESSAGE;
  return new PipelineError(code, message, systemCode === undefined ? {} : { systemCode });
}

/**
 * Converts any thrown value into a PipelineError without copying raw messages, which may hold
 * secrets. A PipelineError, also one wrapped as the `cause` of another error (a source that
 * changed during an upload), passes unchanged. It is the fallback: transport adapters classify
 * HTTP statuses themselves first.
 */
export function toPipelineError(error: unknown): PipelineError {
  const carried = carriedPipelineError(error);
  if (carried) return carried;
  const namedFailure = FAILURES_BY_ERROR_NAME.get(errorName(error) ?? '');
  if (namedFailure) return new PipelineError(namedFailure.code, namedFailure.message);
  return classifiedSystemError(error);
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PipelineError('CANCELLED', 'Operation was cancelled.');
}
