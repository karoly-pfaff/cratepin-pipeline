import { mkdir, rename, rmdir, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { entryKindAt } from '../../paths/path-containment.ts';

/**
 * The file system operations that publish or remove an output tree. Tests replace them to fail
 * or stop at any step; everything else reads the real file system.
 */
export interface PublicationFileSystem {
  readonly rename: (from: string, to: string) => Promise<void>;
  /** Creates one directory, failing if anything exists at its name. */
  readonly mkdir: (path: string) => Promise<void>;
  /** Removes one empty directory; never recursive. */
  readonly rmdir: (path: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export const NODE_PUBLICATION_FILE_SYSTEM: PublicationFileSystem = {
  rename: (from, to) => rename(from, to),
  mkdir: async (path) => {
    await mkdir(path);
  },
  rmdir: (path) => rmdir(path),
  unlink: (path) => unlink(path),
  wait: async (milliseconds) => {
    await delay(milliseconds);
  },
};

/** Waits before each retry of a rename that a briefly open file blocks, about 3 s in all. */
const RENAME_RETRY_WAITS = [50, 100, 200, 400, 800, 1600];

/** Windows reports a file or directory another program holds open with these codes. */
const BLOCKED_CODES: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Whether a failed rename was blocked by a file or directory another program holds open. */
export function isBlocked(error: unknown): boolean {
  return BLOCKED_CODES.has((error as { code?: unknown } | null)?.code);
}

/** One rename: whether it replaces an existing file at `to` on purpose. */
interface RenameStep {
  readonly from: string;
  readonly to: string;
  readonly isReplacing: boolean;
}

/** One attempt: true once renamed, false when blocked and worth another try; throws otherwise. */
async function renamedOrBlocked(
  fileSystem: PublicationFileSystem,
  { from, to, isReplacing }: RenameStep,
): Promise<boolean> {
  try {
    await fileSystem.rename(from, to);
    return true;
  } catch (error) {
    if (!isBlocked(error)) throw error;
    if (isReplacing || (await entryKindAt(to)) === 'absent') return false;
    throw error;
  }
}

async function renameRetrying(fileSystem: PublicationFileSystem, step: RenameStep): Promise<void> {
  for (const pause of RENAME_RETRY_WAITS) {
    if (await renamedOrBlocked(fileSystem, step)) return;
    await fileSystem.wait(pause);
  }
  await fileSystem.rename(step.from, step.to);
}

/**
 * Renames `from` to `to`, retrying while another program (an indexer, a virus scanner, an
 * editor) briefly holds a file open. A retry happens only while `to` is still absent, as on
 * Windows EPERM is ambiguous. The last attempt's error is thrown when the rename never succeeds.
 */
export function renameWithRetry(
  fileSystem: PublicationFileSystem,
  from: string,
  to: string,
): Promise<void> {
  return renameRetrying(fileSystem, { from, to, isReplacing: false });
}

/**
 * Renames the file `from` over the file `to` in one step (a reader sees the old file or the new
 * one), retrying while another program briefly holds `to` open. The last attempt's error is
 * thrown when the rename never succeeds.
 */
export function replaceFileWithRetry(
  fileSystem: PublicationFileSystem,
  from: string,
  to: string,
): Promise<void> {
  return renameRetrying(fileSystem, { from, to, isReplacing: true });
}
