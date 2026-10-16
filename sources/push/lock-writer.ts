import { randomUUID } from 'node:crypto';
import { open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { PipelineError } from '../errors.ts';
import { loadCommittedLock } from '../lock/lock-file.ts';
import type { FinalizedLock } from '../lock/lock-finalization.ts';
import { serializeLock } from '../lock/source-lock.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { assertLayoutStillSafe } from '../paths/layout/checked-project.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { entryKindAt } from '../paths/path-containment.ts';

const LOCK_NOT_WRITTEN = 'the lock was not written';
/** `<lock file>.<uuid>.tmp`: the only files next to the lock this writer creates or removes. */
const TEMPORARY_SUFFIX = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * Fails before any transfer if the lock could not be written afterwards: the layout must still
 * be safe and the lock's directory must exist (the preflight accepts a not-yet-created one).
 */
export async function assertLockWritable(project: CheckedProject): Promise<void> {
  await assertLayoutStillSafe(project, LOCK_NOT_WRITTEN);
  const lockDirectory = dirname(project.paths.lockFilePath);
  if ((await entryKindAt(lockDirectory)) === 'directory') return;
  throw new PipelineError('NOT_FOUND', 'The directory for the lock file does not exist.', {
    lockDirectory,
  });
}

/** Writes, flushes and closes a new file; refuses to replace anything at `path`. */
async function writeDurably(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

/** The lock on disk must still be the one the push started from, or another change would be lost. */
async function assertLockUnchanged(
  project: CheckedProject,
  committed: SourceLock | undefined,
): Promise<void> {
  const current = await loadCommittedLock(project);
  const isStillAbsent = committed === undefined && current.status === 'absent';
  const isStillSame =
    committed !== undefined &&
    current.status === 'valid' &&
    serializeLock(current.lock) === serializeLock(committed);
  if (isStillAbsent || isStillSame) return;
  throw new PipelineError(
    'OUTPUT_CONFLICT',
    'The lock file changed while pushing (a pull or another push?); scan and push again.',
    { lockFilePath: project.paths.lockFilePath },
  );
}

/** Removes temporary files an interrupted earlier write left next to the lock; nothing else. */
async function removeStaleTemporaryFiles(lockFilePath: string): Promise<void> {
  const prefix = basename(lockFilePath);
  const names = await readdir(dirname(lockFilePath));
  const stale = names.filter(
    (name) => name.startsWith(prefix) && TEMPORARY_SUFFIX.test(name.slice(prefix.length)),
  );
  await Promise.all(stale.map((name) => rm(join(dirname(lockFilePath), name), { force: true })));
}

async function replaceLockFile(project: CheckedProject, text: string): Promise<void> {
  const temporaryPath = `${project.paths.lockFilePath}.${randomUUID()}.tmp`;
  try {
    await writeDurably(temporaryPath, text);
    await assertLayoutStillSafe(project, LOCK_NOT_WRITTEN);
    await rename(temporaryPath, project.paths.lockFilePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Replaces the committed lock with the finalized one in one step, unless it already has exactly
 * that content. The lock must still be `committed` (the one the push started from). The text
 * goes to a new temporary file next to the lock, is flushed to disk and renamed over the lock;
 * on any failure the temporary file is removed and the previous lock stays exactly as it was.
 * Returns whether the lock file changed.
 */
export async function writeFinalizedLock(
  project: CheckedProject,
  finalized: FinalizedLock,
  committed: SourceLock | undefined,
): Promise<boolean> {
  await assertLayoutStillSafe(project, LOCK_NOT_WRITTEN);
  await assertLockUnchanged(project, committed);
  await removeStaleTemporaryFiles(project.paths.lockFilePath);
  const text = finalized.committedText();
  if (committed !== undefined && serializeLock(committed) === text) return false;
  await replaceLockFile(project, text);
  return true;
}
