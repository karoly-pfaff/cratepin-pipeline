import { PipelineError, throwIfCancelled } from '../../errors.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import type { ReportIssue } from '../../report.ts';
import type { OutputOwner } from '../ownership/output-marker.ts';
import { assertReplaceableRoot } from '../ownership/owned-root.ts';
import { renameWithRetry } from './publication-files.ts';
import type { PublicationFileSystem } from './publication-files.ts';
import { publicationStepFailure } from './publication-failures.ts';
import { keptPathNotices, removeListedTree } from '../files/tree-removal.ts';
import type { TreeRemoval } from '../files/tree-removal.ts';
import { moveBackupToTrash, restoreBackup } from '../layout/work-directory.ts';
import type { WorkDirectory } from '../layout/work-directory.ts';

/** A complete, audited staging tree and where it goes. */
export interface DirectorySwap {
  readonly fileSystem: PublicationFileSystem;
  readonly work: WorkDirectory;
  readonly owner: OutputOwner;
  readonly signal?: AbortSignal | undefined;
}

/** What the swap left behind once the new root was in place. */
export interface SwapResult {
  readonly notices: readonly ReportIssue[];
  readonly cleanup: TreeRemoval;
}

const NOTHING_REMOVED: TreeRemoval = { removedFileCount: 0, keptPaths: [] };

/** The new root could not take the old one's place: put the old one back, or say where it is. */
async function rollBack(swap: DirectorySwap, cause: unknown): Promise<never> {
  const { fileSystem, work } = swap;
  try {
    await restoreBackup(fileSystem, work);
  } catch {
    throw new PipelineError(
      'OUTPUT_CONFLICT',
      'The output directory is missing: the new output could not be moved in and the previous one not back. The previous output is in backupDir; the next build restores it.',
      { reason: 'SWAP_INCOMPLETE', path: work.root, backupDir: work.backup },
    );
  }
  throw publicationStepFailure(
    work.root,
    cause,
    'the previous output was restored and nothing changed',
  );
}

async function moveNewRootIn(swap: DirectorySwap, hadRoot: boolean): Promise<void> {
  const { fileSystem, work } = swap;
  try {
    await renameWithRetry(fileSystem, work.staging, work.root);
  } catch (error) {
    if (hadRoot) await rollBack(swap, error);
    throw publicationStepFailure(work.root, error, 'nothing changed');
  }
}

/**
 * After the commit the backup goes to the trash, so a half-removed one is never rolled back;
 * what its removal keeps is reported.
 */
async function retireBackup(swap: DirectorySwap): Promise<SwapResult> {
  const { fileSystem, work } = swap;
  const trash = await moveBackupToTrash(fileSystem, work).catch(() => undefined);
  if (trash === undefined) {
    const notice = {
      path: work.backup,
      code: 'BACKUP_KEPT',
      message: 'The previous output could not be moved to the trash; the next build removes it.',
    };
    return { notices: [notice], cleanup: NOTHING_REMOVED };
  }
  const cleanup = await removeListedTree(fileSystem, trash);
  return { notices: keptPathNotices(cleanup.keptPaths), cleanup };
}

/** The last checks before the swap; whether there is an old root to move aside. */
async function assertSwapMayStart(swap: DirectorySwap): Promise<boolean> {
  const { work } = swap;
  throwIfCancelled(swap.signal);
  const rootState = await assertReplaceableRoot(work.root, swap.owner);
  if ((await entryKindAt(work.backup)) !== 'absent') {
    throw new PipelineError('OUTPUT_CONFLICT', 'An earlier swap was not cleaned up; build again.', {
      reason: 'INTERRUPTED_SWAP_UNCLEAR',
      path: work.backup,
    });
  }
  return rootState.state !== 'absent';
}

async function moveOldRootAside(swap: DirectorySwap): Promise<void> {
  try {
    await renameWithRetry(swap.fileSystem, swap.work.root, swap.work.backup);
  } catch (error) {
    throw publicationStepFailure(swap.work.root, error, 'nothing changed');
  }
}

/**
 * Replaces the output root with the staged tree by two renames: the root into the backup, then
 * the staging into the root. The output is checked again just before; Ctrl+C is no longer
 * honoured from here. If the second rename fails the backup goes back (OUTPUT_IN_USE, exit 9);
 * if that fails too, SWAP_INCOMPLETE names the backup, which the next build restores. Once the
 * new root is in place (the commit point) the old one moves to the trash and is removed.
 */
export async function swapInStaging(swap: DirectorySwap): Promise<SwapResult> {
  const hadRoot = await assertSwapMayStart(swap);
  if (hadRoot) await moveOldRootAside(swap);
  await moveNewRootIn(swap, hadRoot);
  return hadRoot ? retireBackup(swap) : { notices: [], cleanup: NOTHING_REMOVED };
}
