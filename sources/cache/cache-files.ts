import { rename, rm } from 'node:fs/promises';

import { PipelineError, toPipelineError } from '../errors.ts';
import { linkIfAbsent } from '../paths/files/create-only-files.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import {
  checkRegularFile,
  readRegularFile,
  streamRegularFile,
} from '../paths/files/regular-files.ts';
import type { FileMessages, FileReading, FileState } from '../paths/files/regular-files.ts';
import type { ExpectedContent } from '../storage/transfer/checked-body.ts';

/** `verified` is the only hit; `corrupt` is anything at the file's name that is not exactly it. */
export type EntryState = FileState;

/** A cache file's bytes once read, or why there are none. */
export type CacheFileReading = FileReading;

const CACHE_FILE_MESSAGES: FileMessages = {
  cannotInspect: 'A cache file cannot be inspected.',
  cannotOpen: 'A cache file cannot be opened.',
  notRegular: 'A cache file is not a regular file.',
};

/**
 * Checks one cache file by hashing all of it, every time: existence, size, timestamps or an
 * ETag never make a hit. A link, directory or other special file at its name is corrupt.
 */
export function checkCacheFile(path: string, expected: ExpectedContent): Promise<EntryState> {
  return checkRegularFile(path, expected, CACHE_FILE_MESSAGES);
}

/** Reads a whole cache file of at most `maxBytes`; a larger file is corrupt and not read. */
export function readCacheFile(path: string, maxBytes: number): Promise<CacheFileReading> {
  return readRegularFile(path, maxBytes, CACHE_FILE_MESSAGES);
}

/** Streams a cache file's bytes; callers that need them exact pass them through a content check. */
export function streamCacheFile(path: string): AsyncGenerator<Uint8Array> {
  return streamRegularFile(path, CACHE_FILE_MESSAGES);
}

/** Renames `from` to `to`; false when `from` is gone (another run moved it first). */
async function moveIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    const failure = toPipelineError(error);
    if (failure.code === 'NOT_FOUND') return false;
    throw new PipelineError(
      'IO_FAILED',
      'A corrupt cache file could not be moved to the quarantine.',
      { ...failure.details, path: from },
    );
  }
}

/** True for a regular file with exactly the expected content; anything else, unreadable too, is not. */
async function isVerifiedFileAt(path: string, expected: ExpectedContent): Promise<boolean> {
  return (
    (await entryKindAt(path)) === 'file' && (await checkCacheFile(path, expected)) === 'verified'
  );
}

/** A cache file and the new, unique quarantine name it moves to when it fails verification. */
export interface QuarantineMove {
  readonly from: string;
  readonly to: string;
}

/**
 * Moves a corrupt cache file into the quarantine under a new unique name, so it is never served
 * again and a verified file can take its place; a file another process already moved away
 * counts as done. Corrupt files are never deleted here. Another run may have published a
 * verified file since this one found the corrupt one: what was moved is checked, and a verified
 * file goes back under its name (its moved copy is then removed). Between the move and the link
 * back the name is briefly absent, which a reader in that moment sees as a miss. Returns true
 * when a verified file is under the name afterwards.
 */
export async function quarantineCacheFile(
  { from, to }: QuarantineMove,
  expected: ExpectedContent,
): Promise<boolean> {
  if (!(await moveIfPresent(from, to)) || !(await isVerifiedFileAt(to, expected))) return false;
  const isPutBack = await linkIfAbsent(to, from);
  await rm(to, { force: true });
  return isPutBack || (await checkCacheFile(from, expected)) === 'verified';
}
