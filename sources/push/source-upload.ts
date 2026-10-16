import type { BlobReader, BlobWriter, CreateOutcome, TransferOptions } from '../blob-store.ts';
import type { VerifiedObject } from '../lock/lock-finalization.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';
import { verifyByReadback } from './object-verification.ts';
import { verifiedSourceBody } from './source-upload-body.ts';

/** Storage access a push needs: create-only writes and reads for verification. */
export interface PushStorage {
  readonly writer: BlobWriter;
  readonly reader: BlobReader;
}

/** One planned object and the local source file that holds its bytes. */
export interface ObjectSource {
  readonly object: PlannedObject;
  readonly sourcePath: string;
}

/** What happened to one object, and the evidence that storage now holds its bytes. */
export interface UploadedObject {
  readonly outcome: CreateOutcome;
  readonly verified: VerifiedObject;
}

/**
 * Uploads one original create-only from its local source file. `already-exists` means an earlier
 * or concurrent writer stored the key; nothing was replaced. The result is not yet proven.
 */
export function createFromSource(
  writer: BlobWriter,
  { object, sourcePath }: ObjectSource,
  options: TransferOptions = {},
): Promise<CreateOutcome> {
  return writer.createBlobIfAbsent(
    {
      key: object.objectKey,
      bytes: object.bytes,
      sha256: object.sha256,
      openBody: () => verifiedSourceBody(sourcePath, object),
    },
    options,
  );
}

/**
 * Uploads one original create-only and proves the result by readback: created or existing,
 * the stored bytes must hash to the expected SHA-256; wrong bytes fail with INTEGRITY_MISMATCH.
 * If the readback fails, the caller does not learn whether the object was created; code that
 * reports created objects (like push) calls `createFromSource` and `verifyByReadback` itself.
 */
export async function uploadAndVerify(
  storage: PushStorage,
  source: ObjectSource,
  options: TransferOptions = {},
): Promise<UploadedObject> {
  const outcome = await createFromSource(storage.writer, source, options);
  const verified = await verifyByReadback(storage.reader, source.object, options);
  return { outcome, verified };
}
