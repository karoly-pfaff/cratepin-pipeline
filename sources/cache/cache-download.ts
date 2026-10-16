import { rm } from 'node:fs/promises';

import type { BlobReader } from '../blob-store.ts';
import { PipelineError } from '../errors.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';
import { writeNewFile } from '../paths/files/create-only-files.ts';
import { withContentCheck } from '../storage/transfer/checked-body.ts';
import { partPathOf, quarantinePathOf } from './cache-file-names.ts';
import { publishVerifiedPart } from './cache-publication.ts';
import { originalPathOf } from './cache-layout.ts';
import type { CacheLayout } from './cache-layout.ts';

/** One locked object to fetch into the cache with the configured read transport. */
export interface CacheDownload {
  readonly layout: CacheLayout;
  readonly object: PlannedObject;
  readonly reader: BlobReader;
  readonly signal: AbortSignal | undefined;
}

function downloadMismatch(object: PlannedObject): PipelineError {
  return new PipelineError(
    'INTEGRITY_MISMATCH',
    'The downloaded object does not have the locked SHA-256 and size.',
    { key: object.objectKey },
  );
}

/**
 * Downloads one object into a private `.part` file, hashing and counting every byte (stopping at
 * the first byte too many), flushes it, and only then gives it the entry's name in one step, so a
 * reader never sees a partial or unverified entry. The part file is removed in every case.
 */
export async function downloadIntoCache({
  layout,
  object,
  reader,
  signal,
}: CacheDownload): Promise<void> {
  const partPath = partPathOf(layout, object.sha256);
  try {
    const body = reader.readBlob(object.objectKey, { signal });
    await writeNewFile(
      partPath,
      withContentCheck(body, object, () => downloadMismatch(object)),
      signal,
    );
    await publishVerifiedPart({
      part: partPath,
      path: originalPathOf(layout, object.sha256),
      quarantineTarget: () => quarantinePathOf(layout, object.sha256),
      expected: object,
    });
  } finally {
    await rm(partPath, { force: true });
  }
}
