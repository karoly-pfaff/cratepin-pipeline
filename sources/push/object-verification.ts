import { createHash } from 'node:crypto';

import type { BlobReader, TransferOptions } from '../blob-store.ts';
import { PipelineError } from '../errors.ts';
import type { VerifiedObject } from '../lock/lock-finalization.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';

function storedBytesDifferError(object: PlannedObject): PipelineError {
  return new PipelineError(
    'INTEGRITY_MISMATCH',
    'The stored object does not hold the expected bytes; it was not replaced.',
    { key: object.objectKey },
  );
}

/** SHA-256 and size of the stored bytes; stops downloading once more bytes than expected came. */
async function storedDigestOf(
  reader: BlobReader,
  object: PlannedObject,
  options: TransferOptions,
): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hasher = createHash('sha256');
  let bytes = 0;
  for await (const chunk of reader.readBlob(object.objectKey, options)) {
    bytes += chunk.length;
    if (bytes > object.bytes) throw storedBytesDifferError(object);
    hasher.update(chunk);
  }
  return { sha256: hasher.digest('hex'), bytes };
}

/**
 * Downloads the stored object and hashes it: the only proof that storage holds exactly these
 * bytes, used for every object a lock references, also those an earlier lock already pinned.
 * Neither the ETag nor `x-amz-meta-sha256` is trusted.
 */
export async function verifyByReadback(
  reader: BlobReader,
  object: PlannedObject,
  options: TransferOptions = {},
): Promise<VerifiedObject> {
  const { sha256, bytes } = await storedDigestOf(reader, object, options);
  if (sha256 !== object.sha256 || bytes !== object.bytes) throw storedBytesDifferError(object);
  return { objectKey: object.objectKey, sha256, bytes };
}
