import type { BlobUpload, CreateOutcome } from '../../blob-store.ts';
import { chunksUntilCancelled } from '../../byte-streams.ts';
import { PipelineError, toPipelineError } from '../../errors.ts';
import { BoundedTasks } from '../transfer/bounded-tasks.ts';
import {
  abortRefusedUpload,
  completeUpload,
  failureAfterAbort,
  sha256Hex,
} from './multipart-ending.ts';
import type { CompletedPart, MultipartSession } from './multipart-ending.ts';
import { eitherSignal } from '../transfer/signals.ts';
import { partsOf } from './part-splitter.ts';
import { bodyOfDeclaredContent, statR2Object } from '../r2/r2-objects.ts';
import { sendSucceedingWithRetries } from '../r2/r2-requests.ts';
import { discardControlBody, readControlText } from '../http/response-bodies.ts';
import type { R2Transfer } from '../transfer/transfer-settings.ts';

const UPLOAD_ID = /<UploadId>([^<]+)<\/UploadId>/;

async function initiateUpload(
  transfer: R2Transfer,
  upload: BlobUpload,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await sendSucceedingWithRetries(
    transfer,
    () => ({
      method: 'POST',
      key: upload.key,
      query: { uploads: '' },
      headers: { 'x-amz-meta-sha256': upload.sha256 },
    }),
    signal,
  );
  const text = await readControlText(response, {
    key: upload.key,
    timeoutMs: transfer.settings.requestTimeoutMs,
  });
  const uploadId = UPLOAD_ID.exec(text)?.[1];
  if (uploadId !== undefined) return uploadId;
  throw new PipelineError('INVALID_DATA', 'R2 returned no multipart upload ID.', {
    key: upload.key,
  });
}

async function uploadPart(
  session: MultipartSession,
  partNumber: number,
  content: Buffer,
): Promise<CompletedPart> {
  const response = await sendSucceedingWithRetries(
    session.transfer,
    () => ({
      method: 'PUT',
      key: session.key,
      query: { partNumber: String(partNumber), uploadId: session.uploadId },
      headers: { 'content-length': String(content.length) },
      body: content,
      payloadSha256: sha256Hex(content),
    }),
    session.signal,
  );
  const etag = response.headers.get('etag');
  await discardControlBody(response, {
    key: session.key,
    timeoutMs: session.transfer.settings.requestTimeoutMs,
  });
  if (etag !== null) return { partNumber, etag };
  throw new PipelineError('INVALID_DATA', 'R2 returned no part ETag.', { key: session.key });
}

/**
 * Uploads parts with at most `partConcurrency` in flight, so memory holds at most that many parts
 * plus the one being read, and remembers each part's ETag for the completion. The first failing
 * part cancels the parts still running, so nothing keeps uploading for a doomed upload.
 */
class PartUploads {
  private readonly partSession: MultipartSession;
  private readonly stopParts = new AbortController();
  private readonly tasks: BoundedTasks;
  private readonly completed: CompletedPart[] = [];

  constructor(session: MultipartSession) {
    this.partSession = { ...session, signal: eitherSignal(session.signal, this.stopParts.signal) };
    this.tasks = new BoundedTasks(session.transfer.settings.partConcurrency);
  }

  /** Uploads every part; a failure stops reading and lets running parts settle first. */
  async uploadEach(parts: AsyncIterable<Buffer>): Promise<void> {
    let partNumber = 0;
    try {
      for await (const content of chunksUntilCancelled(parts, this.partSession.signal)) {
        partNumber += 1;
        await this.start(partNumber, content);
      }
      await this.tasks.finish();
    } catch (error) {
      await this.failAfterStoppingParts(error);
    }
  }

  /** Cancels the parts still running, also when reading the body failed, and waits for them. */
  private async failAfterStoppingParts(error: unknown): Promise<never> {
    this.stopParts.abort();
    await this.tasks.settle();
    // A part failure aborts the reader too; retain that failure instead of its cancellation.
    if (toPipelineError(error).code === 'CANCELLED') await this.tasks.finish();
    throw error;
  }

  completedInOrder(): CompletedPart[] {
    return this.completed.toSorted((left, right) => left.partNumber - right.partNumber);
  }

  private start(partNumber: number, content: Buffer): Promise<void> {
    return this.tasks.start(async () => {
      try {
        this.completed.push(await uploadPart(this.partSession, partNumber, content));
      } catch (error) {
        this.stopParts.abort();
        throw error;
      }
    });
  }
}

async function uploadAllParts(
  session: MultipartSession,
  body: AsyncIterable<Uint8Array>,
): Promise<CompletedPart[]> {
  const uploads = new PartUploads(session);
  await uploads.uploadEach(partsOf(body, session.transfer.settings.multipartPartBytes));
  return uploads.completedInOrder();
}

/** Uploads every part and completes; any failure aborts the owned upload first. */
async function completedOrAborted(
  session: MultipartSession,
  upload: BlobUpload,
): Promise<CreateOutcome> {
  try {
    const parts = await uploadAllParts(session, bodyOfDeclaredContent(upload));
    return await completeUpload(session, parts);
  } catch (error) {
    throw await failureAfterAbort(session, error);
  }
}

/**
 * Uploads a large original in parts. An existing key is detected by HEAD before starting, and the
 * completion is conditional, so a writer that created the key meanwhile is never replaced: the
 * outcome is then `already-exists` and the upload is aborted. Every upload is verified by
 * readback afterwards either way. Any failure or cancellation aborts the owned upload, so
 * incomplete bytes are never completed.
 */
export async function createViaMultipart(
  transfer: R2Transfer,
  upload: BlobUpload,
  signal: AbortSignal | undefined,
): Promise<CreateOutcome> {
  if ((await statR2Object(transfer, upload.key, signal)) !== undefined) return 'already-exists';
  const uploadId = await initiateUpload(transfer, upload, signal).catch((error: unknown) => {
    throw unconfirmedInitiation(error, upload.key);
  });
  const session: MultipartSession = { transfer, key: upload.key, uploadId, signal };
  const outcome = await completedOrAborted(session, upload);
  if (outcome === 'already-exists') await abortRefusedUpload(session);
  return outcome;
}

function unconfirmedInitiation(error: unknown, key: string): PipelineError {
  const failure = toPipelineError(error);
  return new PipelineError(failure.code, failure.message, {
    ...failure.details,
    key,
    unconfirmedMultipartInitiation: true,
  });
}
