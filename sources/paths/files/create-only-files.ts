import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { link, mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { PipelineError, toPipelineError } from '../../errors.ts';
import { entryKindAt } from '../path-containment.ts';

function hasSystemCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}

/**
 * Resolves once the stream's file handle is closed. `pipeline` can settle on an error before
 * that; until the close, Windows still lists a removed file, and a file still being opened
 * would appear only after the caller tried to remove it.
 */
function closeOf(file: WriteStream): Promise<void> {
  if (file.closed) return Promise.resolve();
  return new Promise((resolve) => {
    file.once('close', () => {
      resolve();
    });
  });
}

/**
 * Writes the chunks to a new file at `path`, refusing to replace anything there, and flushes it
 * to disk before closing. It settles only after the file is closed, so a failed or cancelled
 * write leaves a partial file the caller can remove at once.
 */
export async function writeNewFile(
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const file = createWriteStream(path, { flags: 'wx', flush: true });
  try {
    await pipeline(chunks, file, { signal });
  } finally {
    await closeOf(file);
  }
}

/**
 * Gives the complete file at `existingPath` the additional name `newPath`, only if nothing has
 * that name yet: a hard link appears in one step, so a reader sees the whole file or nothing, and
 * it never replaces a file someone else created. Returns false when `newPath` is taken. Needs a
 * file system with hard links (NTFS, APFS, ext4 and the like); any other failure, whatever the
 * platform reports (FAT volumes on Windows report EISDIR), is IO_FAILED with its system code.
 */
export async function linkIfAbsent(existingPath: string, newPath: string): Promise<boolean> {
  try {
    await link(existingPath, newPath);
    return true;
  } catch (error) {
    if (hasSystemCode(error, 'EEXIST')) return false;
    const { details } = toPipelineError(error);
    throw new PipelineError(
      'IO_FAILED',
      'A file could not be linked into place: no permission, or no hard links on this file system.',
      { ...details, path: newPath },
    );
  }
}

/**
 * Makes sure `path` is a real directory, creating it (not its parents) when absent. A file or a
 * link in its place is a conflict: nothing is ever written through a link.
 */
export async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!hasSystemCode(error, 'EEXIST')) throw error;
  }
  if ((await entryKindAt(path)) === 'directory') return;
  throw new PipelineError('OUTPUT_CONFLICT', 'A file or link is where a directory belongs.', {
    path,
  });
}
