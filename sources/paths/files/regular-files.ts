import type { FileHandle } from 'node:fs/promises';

import { PipelineError, toPipelineError } from '../../errors.ts';
import { hashOpenedFile } from '../../opened-file-hash.ts';
import type { ExpectedContent } from '../../storage/transfer/checked-body.ts';
import { entryKindAt } from '../path-containment.ts';
import { openRegularFile } from './source-file-opening.ts';
import { readOpenedBytesWithin } from './bounded-text.ts';

/** What to tell the user about a file of one kind (a cache entry, an output) that fails. */
export interface FileMessages {
  readonly cannotInspect: string;
  readonly cannotOpen: string;
  readonly notRegular: string;
}

/**
 * A file checked against the bytes it must hold: `verified` is the only match; `corrupt` is
 * anything else at its name (other bytes, a link, a directory or another special file).
 */
export type FileState = 'verified' | 'absent' | 'corrupt';

/** A file's bytes once read, or why there are none. */
export type FileReading =
  | { readonly state: 'present'; readonly bytes: Uint8Array }
  | { readonly state: 'absent' | 'corrupt' };

type OpenedFile =
  { readonly state: 'open'; readonly file: FileHandle } | { readonly state: 'absent' | 'corrupt' };

/** Opens the regular file, or `absent` when it vanished meanwhile (another run moved it). */
async function openUnlessVanished(path: string, messages: FileMessages): Promise<OpenedFile> {
  try {
    return { state: 'open', file: await openRegularFile(path, messages) };
  } catch (error) {
    if (toPipelineError(error).code === 'NOT_FOUND') return { state: 'absent' };
    throw error;
  }
}

/**
 * Opens a file for reading, never through a link: a link, directory or other special file at
 * its name is `corrupt` and never followed. The caller closes an opened file.
 */
async function openNoFollow(path: string, messages: FileMessages): Promise<OpenedFile> {
  const kind = await entryKindAt(path);
  if (kind === 'file') return openUnlessVanished(path, messages);
  if (kind === 'absent') return { state: 'absent' };
  if (kind !== 'unreadable') return { state: 'corrupt' };
  throw new PipelineError('IO_FAILED', messages.cannotInspect, { path });
}

/** True when the open file has exactly the expected size and SHA-256; reads one byte past it at most. */
async function hasExpectedContent(file: FileHandle, expected: ExpectedContent): Promise<boolean> {
  if ((await file.stat()).size !== expected.bytes) return false;
  const digest = await hashOpenedFile(file, expected.bytes + 1);
  return digest.bytes === expected.bytes && digest.sha256 === expected.sha256;
}

/**
 * Checks a file by hashing all of it, every time: existence, size or timestamps never make a
 * match.
 */
export async function checkRegularFile(
  path: string,
  expected: ExpectedContent,
  messages: FileMessages,
): Promise<FileState> {
  const opened = await openNoFollow(path, messages);
  if (opened.state !== 'open') return opened.state;
  try {
    return (await hasExpectedContent(opened.file, expected)) ? 'verified' : 'corrupt';
  } finally {
    await opened.file.close();
  }
}

/** Reads a whole file of at most `maxBytes`, never through a link; a larger file is `corrupt`. */
export async function readRegularFile(
  path: string,
  maxBytes: number,
  messages: FileMessages,
): Promise<FileReading> {
  const opened = await openNoFollow(path, messages);
  if (opened.state !== 'open') return opened;
  try {
    if ((await opened.file.stat()).size > maxBytes) return { state: 'corrupt' };
    const bytes = await readOpenedBytesWithin(opened.file, maxBytes);
    return bytes === undefined ? { state: 'corrupt' } : { state: 'present', bytes };
  } finally {
    await opened.file.close();
  }
}

/**
 * Streams a file's bytes, opened once as a regular file; callers that need them exact pass them
 * through a content check.
 */
export async function* streamRegularFile(
  path: string,
  messages: FileMessages,
): AsyncGenerator<Uint8Array> {
  const file = await openRegularFile(path, messages);
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) yield chunk as Buffer;
  } finally {
    await file.close();
  }
}
