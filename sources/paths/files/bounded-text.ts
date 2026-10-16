import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { PipelineError } from '../../errors.ts';

const CHUNK_BYTES = 64 * 1024;
/** Read only; where the platform has it (not on Windows), never wait on a FIFO (`O_NONBLOCK`). */
const READ_ONLY_NONBLOCKING_FLAGS =
  constants.O_RDONLY | ('O_NONBLOCK' in constants ? constants.O_NONBLOCK : 0);

/** The `size` bytes of `file` at `position`, fewer at its end, none past it. */
async function chunkAt(file: FileHandle, position: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await file.read({ buffer, position });
  return buffer.subarray(0, bytesRead);
}

/** Up to `limit` bytes of `file` from its start, read chunk by chunk until its end. */
async function leadingBytesOf(file: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = await chunkAt(file, total, Math.min(CHUNK_BYTES, limit - total));
    if (chunk.length === 0) break;
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total);
}

/** Reads from an already opened file, stopping after at most one byte beyond the limit. */
export async function readOpenedBytesWithin(
  file: FileHandle,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const bytes = await leadingBytesOf(file, maxBytes + 1);
  return bytes.length > maxBytes ? undefined : bytes;
}

/**
 * A small text file's content, or `undefined` when it holds more than `maxBytes`: a config, lock,
 * claim or marker that large was not written for this tool. At most `maxBytes + 1` bytes are read,
 * also from a file that grows meanwhile. The opened handle is checked, so anything but a regular
 * file at `path` (a directory, a pipe, a device), also one swapped in meanwhile, is INVALID_DATA
 * naming the path; errors of opening or reading it (a missing file, no access) propagate.
 */
export async function readTextWithin(path: string, maxBytes: number): Promise<string | undefined> {
  const file = await open(path, READ_ONLY_NONBLOCKING_FLAGS);
  try {
    if (!(await file.stat()).isFile()) {
      throw new PipelineError(
        'INVALID_DATA',
        'A config, lock or cache file is not a regular file.',
        {
          path,
        },
      );
    }
    return (await readOpenedBytesWithin(file, maxBytes))?.toString('utf8');
  } finally {
    await file.close();
  }
}
