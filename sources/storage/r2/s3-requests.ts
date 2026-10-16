import { PipelineError } from '../../errors.ts';
import type { ErrorCode, ErrorDetails } from '../../errors.ts';
import type { R2Connection } from './r2-connection.ts';
import { readErrorPrefix } from '../http/response-bodies.ts';
import {
  encodedKeySegments,
  fetchWithHeaderDeadline,
  isRedirectStatus,
} from '../http/http-requests.ts';
import { EMPTY_PAYLOAD_SHA256, encodeRfc3986, signRequest } from './sig-v4.ts';

type S3Method = 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE';

/** One S3 API call against the connection's bucket, signed just before it is sent. */
export interface S3Request {
  readonly method: S3Method;
  /** The object key; the request targets the bucket itself without one. */
  readonly key?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: AsyncIterable<Uint8Array> | Uint8Array;
  /** Hex SHA-256 of `body`; the server rejects a body that does not match it. */
  readonly payloadSha256?: string;
  readonly signal?: AbortSignal | undefined;
  /**
   * Gives up with a transient TimeoutError if the response headers have not arrived within this
   * many milliseconds, counting the time to send the request body.
   */
  readonly timeoutMs?: number;
}

/** R2 accepts SigV4 with region `auto`. */
const R2_SIGNING = { region: 'auto', service: 's3' } as const;
/** S3 error codes that mean the body was not what was declared. */
const INTEGRITY_S3_CODES = new Set(['XAmzContentSHA256Mismatch', 'BadDigest', 'IncompleteBody']);
/** S3 error codes that a later try can get past, whatever their status. */
const TRANSIENT_S3_CODES = new Set(['RequestTimeout', 'SlowDown', 'InternalError']);
const S3_ERROR_CODE = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/;

const ERROR_CODES_BY_STATUS = new Map<number, ErrorCode>([
  [400, 'INVALID_DATA'],
  [401, 'AUTH_FAILED'],
  [403, 'AUTH_FAILED'],
  [404, 'NOT_FOUND'],
  [408, 'TRANSIENT_TRANSFER'],
  [409, 'TRANSIENT_TRANSFER'],
  [429, 'TRANSIENT_TRANSFER'],
]);

const MESSAGES_BY_ERROR_CODE: Readonly<Partial<Record<ErrorCode, string>>> = {
  AUTH_FAILED: 'R2 rejected the credentials or their permissions.',
  NOT_FOUND: 'The object does not exist in the bucket.',
  TRANSIENT_TRANSFER: 'R2 is temporarily unavailable or throttling; the request may succeed later.',
  INTEGRITY_MISMATCH: 'R2 received bytes that do not match their declared SHA-256 or length.',
  INVALID_DATA: 'R2 rejected the request as invalid.',
  CONFIG_INVALID: 'R2 redirected the request; check that the endpoint is the account endpoint.',
};

/** `name=value` pairs encoded exactly as SigV4 canonicalizes them, so sent and signed agree. */
function queryString(query: Readonly<Record<string, string>> | undefined): string {
  const pairs = Object.entries(query ?? {});
  return pairs.map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`).join('&');
}

/** Path-style URL: `<endpoint>/<bucket>/<key>`, every segment percent-encoded once. */
function requestUrl(connection: R2Connection, request: S3Request): URL {
  const keySegments = request.key === undefined ? [] : encodedKeySegments(request.key);
  const segments = [encodeRfc3986(connection.bucket), ...keySegments];
  const url = new URL(`/${segments.join('/')}`, connection.endpoint);
  url.search = queryString(request.query);
  return url;
}

/** Signs and sends one request; the caller interprets the status. Redirects are not followed. */
export function sendS3Request(connection: R2Connection, request: S3Request): Promise<Response> {
  const url = requestUrl(connection, request);
  const payloadSha256 = request.payloadSha256 ?? EMPTY_PAYLOAD_SHA256;
  const toSign = { method: request.method, url, headers: request.headers ?? {}, payloadSha256 };
  const headers = signRequest(toSign, connection.credentials, { ...R2_SIGNING, now: new Date() });
  return fetchWithHeaderDeadline({
    url,
    init: {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body, duplex: 'half' }),
    },
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  });
}

/** Only throttling, timeouts, conflicts and server errors are transient. */
function errorCodeForStatus(status: number, s3Code: string): ErrorCode {
  if (isRedirectStatus(status)) return 'CONFIG_INVALID';
  if (INTEGRITY_S3_CODES.has(s3Code)) return 'INTEGRITY_MISMATCH';
  if (status >= 500 || TRANSIENT_S3_CODES.has(s3Code)) return 'TRANSIENT_TRANSFER';
  return ERROR_CODES_BY_STATUS.get(status) ?? 'IO_FAILED';
}

/** A PipelineError for an unexpected status: status, S3 error code and key, never the body. */
export async function failureOf(
  response: Response,
  key: string | undefined,
  timeoutMs: number,
): Promise<PipelineError> {
  const s3Code = S3_ERROR_CODE.exec(await readErrorPrefix(response, { key, timeoutMs }))?.[1] ?? '';
  const code = errorCodeForStatus(response.status, s3Code);
  const details: ErrorDetails = {
    status: response.status,
    ...(s3Code === '' ? {} : { s3Code }),
    ...(key === undefined ? {} : { key }),
  };
  const message = MESSAGES_BY_ERROR_CODE[code] ?? 'R2 answered with an unexpected status.';
  return new PipelineError(code, message, details);
}
