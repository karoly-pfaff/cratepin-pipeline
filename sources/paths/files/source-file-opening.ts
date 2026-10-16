import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { PipelineError, toPipelineError } from '../../errors.ts';

/**
 * Read only; where the platform has them (not on Windows), refuse a final symbolic link
 * (`O_NOFOLLOW`) and never wait on a FIFO swapped in for the file (`O_NONBLOCK`).
 */
const READ_ONLY_REGULAR_FLAGS =
  constants.O_RDONLY |
  ('O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0) |
  ('O_NONBLOCK' in constants ? constants.O_NONBLOCK : 0);

/** What to tell the user when the file cannot be opened or is not a regular file. */
export interface OpeningMessages {
  readonly cannotOpen: string;
  readonly notRegular: string;
}

const SOURCE_MESSAGES: OpeningMessages = {
  cannotOpen: 'The source file cannot be opened; scan again.',
  notRegular: 'The source is no longer a regular file.',
};

async function openOrExplain(path: string, message: string): Promise<FileHandle> {
  try {
    return await open(path, READ_ONLY_REGULAR_FLAGS);
  } catch (error) {
    const { code, details } = toPipelineError(error);
    throw new PipelineError(code, message, { ...details, path });
  }
}

/**
 * Opens a file for reading and makes sure the handle really is a regular file, so every later
 * read goes to exactly what was checked. A missing file fails with NOT_FOUND, anything but a
 * regular file with INVALID_DATA. The caller closes the handle.
 */
export async function openRegularFile(
  path: string,
  messages: OpeningMessages,
): Promise<FileHandle> {
  const file = await openOrExplain(path, messages.cannotOpen);
  if ((await file.stat()).isFile()) return file;
  await file.close();
  throw new PipelineError('INVALID_DATA', messages.notRegular, { path });
}

/** Opens an original in the source directory; see `openRegularFile`. */
export function openSourceFile(path: string): Promise<FileHandle> {
  return openRegularFile(path, SOURCE_MESSAGES);
}
