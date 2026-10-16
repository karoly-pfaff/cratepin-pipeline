import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

import type { FileDigest } from './hash.ts';

// Kept out of hash.ts: the public declarations must not need Node's types (FileHandle).

/**
 * Streams SHA-256 and the byte count of an already opened file; the caller closes it. With
 * `maxBytesToRead` it stops after that many bytes, so a file that keeps growing cannot hold the
 * reader forever.
 */
export async function hashOpenedFile(
  file: FileHandle,
  maxBytesToRead?: number,
): Promise<FileDigest> {
  const sha256Hasher = createHash('sha256');
  let bytes = 0;
  const range = maxBytesToRead === undefined ? { start: 0 } : { start: 0, end: maxBytesToRead - 1 };
  for await (const chunk of file.createReadStream({ autoClose: false, ...range })) {
    const chunkBytes = chunk as Buffer;
    sha256Hasher.update(chunkBytes);
    bytes += chunkBytes.length;
  }
  return { sha256: sha256Hasher.digest('hex'), bytes };
}
