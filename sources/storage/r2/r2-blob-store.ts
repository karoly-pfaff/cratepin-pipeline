import type { BlobReader, BlobUpload, BlobWriter, CreateOutcome } from '../../blob-store.ts';
import type { R2Connection } from './r2-connection.ts';
import { createViaMultipart } from '../multipart/r2-multipart.ts';
import { openR2ObjectBody, putR2ObjectIfAbsent, statR2Object } from './r2-objects.ts';
import { streamWithPipelineErrors, withPipelineErrors } from '../transfer/transfer-errors.ts';
import { DEFAULT_TRANSFER_SETTINGS } from '../transfer/transfer-settings.ts';
import type { R2Transfer, TransferSettings } from '../transfer/transfer-settings.ts';

/** Single PUT below the multipart threshold, parts at or above it. */
function createIfAbsent(
  transfer: R2Transfer,
  upload: BlobUpload,
  signal: AbortSignal | undefined,
): Promise<CreateOutcome> {
  return upload.bytes >= transfer.settings.multipartThresholdBytes
    ? createViaMultipart(transfer, upload, signal)
    : putR2ObjectIfAbsent(transfer, upload, signal);
}

/** Build-side access: stat and read only (ADR-007). */
export function createR2BlobReader(
  connection: R2Connection,
  settings: TransferSettings = DEFAULT_TRANSFER_SETTINGS,
): BlobReader {
  const transfer: R2Transfer = { connection, settings };
  return {
    statBlob: (key, { signal } = {}) =>
      withPipelineErrors(() => statR2Object(transfer, key, signal), signal),
    readBlob: (key, { signal } = {}) =>
      streamWithPipelineErrors(() => openR2ObjectBody(transfer, key, signal), signal),
  };
}

/** Author access: create-only uploads, in parts for large originals. */
export function createR2BlobWriter(
  connection: R2Connection,
  settings: TransferSettings = DEFAULT_TRANSFER_SETTINGS,
): BlobWriter {
  const transfer: R2Transfer = { connection, settings };
  return {
    createBlobIfAbsent: (upload, { signal } = {}) =>
      withPipelineErrors(() => createIfAbsent(transfer, upload, signal), signal),
  };
}
