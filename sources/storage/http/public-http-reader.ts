import type { BlobReader, StoredBlob } from '../../blob-store.ts';
import { PipelineError } from '../../errors.ts';
import type { ErrorCode } from '../../errors.ts';
import {
  contentLengthOf,
  encodedKeySegments,
  fetchWithHeaderDeadline,
  isRedirectStatus,
  openIdleLimitedBody,
} from './http-requests.ts';
import { withRetries } from '../transfer/retries.ts';
import { streamWithPipelineErrors, withPipelineErrors } from '../transfer/transfer-errors.ts';
import { DEFAULT_TRANSFER_SETTINGS, retryPolicyOf } from '../transfer/transfer-settings.ts';
import type { TransferSettings } from '../transfer/transfer-settings.ts';

/** Where the public objects are and how requests to them are timed and retried. */
interface PublicTransfer {
  readonly baseUrl: URL;
  readonly settings: TransferSettings;
}

const HTTP_NOT_FOUND = 404;
const ERROR_CODES_BY_STATUS = new Map<number, ErrorCode>([
  [401, 'AUTH_FAILED'],
  [403, 'AUTH_FAILED'],
  [HTTP_NOT_FOUND, 'NOT_FOUND'],
  [408, 'TRANSIENT_TRANSFER'],
  [429, 'TRANSIENT_TRANSFER'],
]);
const MESSAGES_BY_ERROR_CODE: Readonly<Partial<Record<ErrorCode, string>>> = {
  CONFIG_INVALID:
    'The public URL redirects elsewhere; set publicBaseUrl to the address that serves the objects.',
  AUTH_FAILED: 'The public URL refuses access to the object.',
  NOT_FOUND: 'The object does not exist at the public URL.',
  TRANSIENT_TRANSFER: 'The public URL is temporarily unavailable; the request may succeed later.',
};

/** Only throttling, timeouts and server errors are transient; a redirect is never followed. */
function errorCodeForStatus(status: number): ErrorCode {
  if (isRedirectStatus(status)) return 'CONFIG_INVALID';
  if (status >= 500) return 'TRANSIENT_TRANSFER';
  return ERROR_CODES_BY_STATUS.get(status) ?? 'IO_FAILED';
}

/** A PipelineError for an unexpected status: status and key; the body is discarded unread. */
async function failureOf(response: Response, key: string): Promise<PipelineError> {
  await response.body?.cancel();
  const code = errorCodeForStatus(response.status);
  const message =
    MESSAGES_BY_ERROR_CODE[code] ?? 'The public URL answered with an unexpected status.';
  return new PipelineError(code, message, { status: response.status, key });
}

/** `<base URL>/<key>` with every key segment percent-encoded once; the base path is kept. */
function objectUrlOf(baseUrl: URL, key: string): URL {
  const basePath = baseUrl.pathname.endsWith('/')
    ? baseUrl.pathname.slice(0, -1)
    : baseUrl.pathname;
  return new URL(`${basePath}/${encodedKeySegments(key).join('/')}`, baseUrl.origin);
}

function sendAnonymous(
  transfer: PublicTransfer,
  request: { readonly method: 'GET' | 'HEAD'; readonly key: string },
  signal: AbortSignal | undefined,
): Promise<Response> {
  return fetchWithHeaderDeadline({
    url: objectUrlOf(transfer.baseUrl, request.key),
    init: { method: request.method },
    signal,
    timeoutMs: transfer.settings.requestTimeoutMs,
  });
}

async function headOnce(
  transfer: PublicTransfer,
  key: string,
  signal: AbortSignal | undefined,
): Promise<StoredBlob | undefined> {
  const response = await sendAnonymous(transfer, { method: 'HEAD', key }, signal);
  if (response.status === HTTP_NOT_FOUND) return undefined;
  if (!response.ok) throw await failureOf(response, key);
  return { key, bytes: contentLengthOf(response, key) };
}

async function getOnce(
  transfer: PublicTransfer,
  key: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const response = await sendAnonymous(transfer, { method: 'GET', key }, signal);
  if (!response.ok) throw await failureOf(response, key);
  return response;
}

/** A GET retried until its response has begun, then streamed once with the idle limit. */
function openPublicBody(
  transfer: PublicTransfer,
  key: string,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<Uint8Array>> {
  const send = (requestSignal: AbortSignal | undefined): Promise<Response> =>
    withRetries(
      () => getOnce(transfer, key, requestSignal),
      retryPolicyOf(transfer.settings, requestSignal),
    );
  return openIdleLimitedBody(send, {
    key,
    idleTimeoutMs: transfer.settings.requestTimeoutMs,
    signal,
  });
}

/**
 * Reads pinned objects anonymously from the `public-http` base URL (ADR-007): no credential is
 * resolved or sent. Timeouts, retries and the refusal of redirects are those of the R2 adapter;
 * like every reader it claims nothing about integrity, which callers verify.
 */
export function createPublicHttpBlobReader(
  baseUrl: URL,
  settings: TransferSettings = DEFAULT_TRANSFER_SETTINGS,
): BlobReader {
  const transfer: PublicTransfer = { baseUrl, settings };
  return {
    statBlob: (key, { signal } = {}) =>
      withPipelineErrors(
        () => withRetries(() => headOnce(transfer, key, signal), retryPolicyOf(settings, signal)),
        signal,
      ),
    readBlob: (key, { signal } = {}) =>
      streamWithPipelineErrors(() => openPublicBody(transfer, key, signal), signal),
  };
}
