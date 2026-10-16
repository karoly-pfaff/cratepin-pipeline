import { createHash } from 'node:crypto';

import type { CreateOutcome } from '../../blob-store.ts';
import { PipelineError, toPipelineError } from '../../errors.ts';
import { HTTP_PRECONDITION_FAILED } from '../r2/r2-objects.ts';
import { sendSucceedingWithRetries, sendWithTimeout } from '../r2/r2-requests.ts';
import { failureOf } from '../r2/s3-requests.ts';
import { discardControlBody, readControlText } from '../http/response-bodies.ts';
import type { R2Transfer } from '../transfer/transfer-settings.ts';

/** One multipart upload this process started and therefore owns until it completes or aborts. */
export interface MultipartSession {
  readonly transfer: R2Transfer;
  readonly key: string;
  readonly uploadId: string;
  readonly signal: AbortSignal | undefined;
}

export interface CompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

const COMPLETION_RESULT = /<CompleteMultipartUploadResult[\s>]/;
/** Cleanup gets its own time budget: the caller's signal may already have been aborted. */
const ABORT_TIMEOUT_MS = 30_000;

export function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function completionXml(parts: readonly CompletedPart[]): string {
  const partElements = parts.map(
    ({ partNumber, etag }) =>
      `<Part><PartNumber>${String(partNumber)}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
  );
  return `<CompleteMultipartUpload>${partElements.join('')}</CompleteMultipartUpload>`;
}

/**
 * Completes once, without retry: a completion whose answer was lost must not be repeated
 * blindly. `If-None-Match: *` makes R2 refuse (412) when another writer created the key since
 * the upload started, leaving that object as it is; the upload then stays open for its owner to
 * abort. S3 may answer 200 with an error document, so the result element is required.
 */
export async function completeUpload(
  session: MultipartSession,
  parts: readonly CompletedPart[],
): Promise<CreateOutcome> {
  const xml = Buffer.from(completionXml(parts));
  const response = await sendWithTimeout(session.transfer, {
    method: 'POST',
    key: session.key,
    query: { uploadId: session.uploadId },
    headers: {
      'content-type': 'application/xml',
      'content-length': String(xml.length),
      'if-none-match': '*',
    },
    body: xml,
    payloadSha256: sha256Hex(xml),
    signal: session.signal,
  });
  if (response.status === HTTP_PRECONDITION_FAILED) {
    await discardControlBody(response, {
      key: session.key,
      timeoutMs: session.transfer.settings.requestTimeoutMs,
    });
    return 'already-exists';
  }
  if (!response.ok)
    throw await failureOf(response, session.key, session.transfer.settings.requestTimeoutMs);
  if (
    COMPLETION_RESULT.test(
      await readControlText(response, {
        key: session.key,
        timeoutMs: session.transfer.settings.requestTimeoutMs,
      }),
    )
  )
    return 'created';
  throw new PipelineError('TRANSIENT_TRANSFER', 'R2 did not confirm the multipart completion.', {
    key: session.key,
  });
}

/**
 * Aborts the owned upload, retrying transient failures within its own time budget, because the
 * caller's signal may already be aborted. An upload storage no longer knows (404 with the S3 code
 * `NoSuchUpload`; any other 404, such as a wrong bucket, is not that) leaves nothing open either.
 * `false` when the abort failed and parts may be left.
 */
async function tryAbortUpload(session: MultipartSession, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await sendSucceedingWithRetries(
      session.transfer,
      () => ({ method: 'DELETE', key: session.key, query: { uploadId: session.uploadId } }),
      signal,
    );
    await discardControlBody(response, {
      key: session.key,
      timeoutMs: session.transfer.settings.requestTimeoutMs,
    });
    return true;
  } catch (error) {
    const failure = toPipelineError(error);
    return failure.code === 'NOT_FOUND' && failure.details.s3Code === 'NoSuchUpload';
  }
}

async function abortUpload(session: MultipartSession): Promise<boolean> {
  const cleanup = new AbortController();
  const timer = setTimeout(() => {
    cleanup.abort();
  }, ABORT_TIMEOUT_MS);
  try {
    return await tryAbortUpload(session, cleanup.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Aborts an upload whose completion storage refused because another writer created the key; a
 * failed abort is a failure naming the upload left open.
 */
export async function abortRefusedUpload(session: MultipartSession): Promise<void> {
  if (await abortUpload(session)) return;
  throw new PipelineError(
    'TRANSIENT_TRANSFER',
    'A refused multipart upload could not be aborted.',
    {
      key: session.key,
      abandonedUploadId: session.uploadId,
    },
  );
}

/** The original failure, after aborting the owned upload; names its ID if the abort failed too. */
export async function failureAfterAbort(
  session: MultipartSession,
  error: unknown,
): Promise<PipelineError> {
  const failure = toPipelineError(error);
  if (await abortUpload(session)) return failure;
  return new PipelineError(failure.code, failure.message, {
    ...failure.details,
    abandonedUploadId: session.uploadId,
  });
}
