import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { partPathOf, quarantinePathOf } from '../cache/cache-file-names.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { publishVerifiedPart } from '../cache/cache-publication.ts';
import type { FileDigest } from '../hash.ts';
import { writeNewFile } from '../paths/files/create-only-files.ts';

export function digestOf(bytes: Uint8Array): FileDigest {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/** Where one new derivative file goes, and the key naming its part and quarantine files. */
export interface DerivativeFile {
  readonly layout: CacheLayout;
  readonly path: string;
  readonly key: string;
}

/** The bytes as a stream of one chunk, the form `writeNewFile` takes. */
async function* asChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  // An async generator must await something; the bytes are already in memory.
  await Promise.resolve();
  yield bytes;
}

/**
 * Writes `bytes` into a private part file, flushed, and only then gives it the file's name in one
 * step, never replacing a name: a correct file already there is kept, a corrupt one quarantined.
 * The part file is removed in every case.
 */
export async function publishDerivativeFile(
  { layout, path, key }: DerivativeFile,
  bytes: Uint8Array,
): Promise<void> {
  const part = partPathOf(layout, key);
  try {
    await writeNewFile(part, asChunks(bytes), undefined);
    await publishVerifiedPart({
      part,
      path,
      quarantineTarget: () => quarantinePathOf(layout, key),
      expected: digestOf(bytes),
    });
  } finally {
    await rm(part, { force: true });
  }
}
