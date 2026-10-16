import { failureOf, sendS3Request } from './s3-requests.ts';
import type { S3Request } from './s3-requests.ts';
import { withRetries } from '../transfer/retries.ts';
import { retryPolicyOf } from '../transfer/transfer-settings.ts';
import type { R2Transfer } from '../transfer/transfer-settings.ts';

/** Sends one request with the transfer's timeout; the caller interprets the status. */
export function sendWithTimeout(transfer: R2Transfer, request: S3Request): Promise<Response> {
  return sendS3Request(transfer.connection, {
    ...request,
    timeoutMs: transfer.settings.requestTimeoutMs,
  });
}

/** Sends one request and fails with the classified error unless it succeeded. */
async function sendSucceeding(transfer: R2Transfer, request: S3Request): Promise<Response> {
  const response = await sendWithTimeout(transfer, request);
  if (!response.ok)
    throw await failureOf(response, request.key, transfer.settings.requestTimeoutMs);
  return response;
}

/**
 * Sends a request and retries transient failures up to the transfer's attempts; any other
 * answer, or the last transient one, fails with its classified error. `request` is rebuilt for
 * every try, so a streamed body is opened afresh.
 */
export function sendSucceedingWithRetries(
  transfer: R2Transfer,
  buildRequest: () => S3Request,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return withRetries(
    () => sendSucceeding(transfer, { ...buildRequest(), signal }),
    retryPolicyOf(transfer.settings, signal),
  );
}
