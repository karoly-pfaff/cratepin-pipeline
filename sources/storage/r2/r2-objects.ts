import type { BlobUpload, CreateOutcome, StoredBlob } from '../../blob-store.ts';
import { PipelineError } from '../../errors.ts';
import { withContentCheck } from '../transfer/checked-body.ts';
import { contentLengthOf, openIdleLimitedBody } from '../http/http-requests.ts';
import { sendSucceedingWithRetries, sendWithTimeout } from './r2-requests.ts';
import { failureOf } from './s3-requests.ts';
import { discardControlBody } from '../http/response-bodies.ts';
import { withRetries } from '../transfer/retries.ts';
import { retryPolicyOf } from '../transfer/transfer-settings.ts';
import type { R2Transfer } from '../transfer/transfer-settings.ts';

const HTTP_NOT_FOUND = 404;
/** The status R2 answers a create-only write when the key already exists. */
export const HTTP_PRECONDITION_FAILED = 412;

function declaredContentMismatch(key: string): PipelineError {
  return new PipelineError(
    'INTEGRITY_MISMATCH',
    'The upload body does not have its declared SHA-256 and length.',
    { key },
  );
}

/**
 * The upload's body, failing with INTEGRITY_MISMATCH unless it has exactly the declared length
 * and SHA-256; the last chunk is held back until that is proven, so neither a single PUT nor a
 * multipart completion can store wrong bytes under the declared hash key.
 */
export function bodyOfDeclaredContent(upload: BlobUpload): AsyncGenerator<Uint8Array> {
  return withContentCheck(upload.openBody(), upload, () => declaredContentMismatch(upload.key));
}

async function headObject(
  transfer: R2Transfer,
  key: string,
  signal: AbortSignal | undefined,
): Promise<StoredBlob | undefined> {
  const response = await sendWithTimeout(transfer, { method: 'HEAD', key, signal });
  if (response.status === HTTP_NOT_FOUND) return undefined;
  if (!response.ok) throw await failureOf(response, key, transfer.settings.requestTimeoutMs);
  return { key, bytes: contentLengthOf(response, key) };
}

/** The object's size, or `undefined` when it does not exist; transient failures are retried. */
export function statR2Object(
  transfer: R2Transfer,
  key: string,
  signal: AbortSignal | undefined,
): Promise<StoredBlob | undefined> {
  return withRetries(
    () => headObject(transfer, key, signal),
    retryPolicyOf(transfer.settings, signal),
  );
}

/**
 * Starts a GET, retrying until the response has begun; the body is then streamed once, failing
 * if it stalls for longer than the request timeout between two chunks.
 */
export function openR2ObjectBody(
  transfer: R2Transfer,
  key: string,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<Uint8Array>> {
  const send = (requestSignal: AbortSignal | undefined): Promise<Response> =>
    sendSucceedingWithRetries(transfer, () => ({ method: 'GET', key }), requestSignal);
  return openIdleLimitedBody(send, {
    key,
    idleTimeoutMs: transfer.settings.requestTimeoutMs,
    signal,
  });
}

async function putIfAbsentOnce(
  transfer: R2Transfer,
  upload: BlobUpload,
  signal: AbortSignal | undefined,
): Promise<CreateOutcome> {
  const response = await sendWithTimeout(transfer, {
    method: 'PUT',
    key: upload.key,
    headers: {
      'content-length': String(upload.bytes),
      'if-none-match': '*',
      'x-amz-meta-sha256': upload.sha256,
    },
    body: bodyOfDeclaredContent(upload),
    payloadSha256: upload.sha256,
    signal,
  });
  if (!response.ok && response.status !== HTTP_PRECONDITION_FAILED) {
    throw await failureOf(response, upload.key, transfer.settings.requestTimeoutMs);
  }
  await discardControlBody(response, {
    key: upload.key,
    timeoutMs: transfer.settings.requestTimeoutMs,
  });
  return response.ok ? 'created' : 'already-exists';
}

/**
 * A create-only PUT: `If-None-Match: *` makes R2 refuse to replace an existing key (412), and
 * the declared SHA-256 is signed as the payload hash, so R2 refuses different bytes. The
 * `x-amz-meta-sha256` metadata is informational only; it never proves integrity. A transient
 * failure is retried with a freshly opened body.
 */
export function putR2ObjectIfAbsent(
  transfer: R2Transfer,
  upload: BlobUpload,
  signal: AbortSignal | undefined,
): Promise<CreateOutcome> {
  return withRetries(
    () => putIfAbsentOnce(transfer, upload, signal),
    retryPolicyOf(transfer.settings, signal),
  );
}
