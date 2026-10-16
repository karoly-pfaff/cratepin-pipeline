import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PipelineError } from '../../errors.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import type { ReportIssue } from '../../report.ts';
import type { RecoveryOutcome, RecoveryResult } from './output-recovery.ts';
import { GENERATION_LISTING_NAME } from '../generation/generation-listing.ts';
import { readGenerationListing } from '../generation/listing-reading.ts';
import { MAX_TOOL_JSON_BYTES, readOutputFile } from '../files/output-files.ts';
import { OUTPUT_MARKER_NAME, outputMarkerTextOf } from '../ownership/output-marker.ts';
import type { OutputOwner } from '../ownership/output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';
import { auditOutputTree } from '../files/tree-audit.ts';
import { assertReplaceableRoot } from '../ownership/owned-root.ts';
import type { PublicationFileSystem } from './publication-files.ts';
import { publicationStepFailure } from './publication-failures.ts';
import { removeTrashedTrees } from '../files/trash-removal.ts';
import {
  combinedRemoval,
  keptPathNotices,
  removeOwnStaging,
  ROOT_TOOL_FILE_NAMES,
} from '../files/tree-removal.ts';
import {
  moveBackupToTrash,
  OUTPUT_CLAIMS_DIRECTORY_NAME,
  removeEmptyWorkDirectory,
  restoreBackup,
} from '../layout/work-directory.ts';
import type { WorkDirectory } from '../layout/work-directory.ts';

/** The work directory of a build that may have ended early, and whose output it is. */
export interface RecoveryRequest {
  readonly fileSystem: PublicationFileSystem;
  readonly work: WorkDirectory;
  readonly owner: OutputOwner;
}

/** How an interrupted swap was finished. */
interface FinishedSwap {
  readonly outcome: RecoveryOutcome;
  readonly notices: readonly ReportIssue[];
}

/** What removing a crashed build's staging and trash removed and kept. */
interface LeftoverRemoval {
  readonly notices: readonly ReportIssue[];
  readonly removedFileCount: number;
}

function unclear(work: WorkDirectory, message: string): PipelineError {
  return new PipelineError(
    'OUTPUT_CONFLICT',
    `${message}; nothing was changed. Check ${work.directory}.`,
    { reason: 'INTERRUPTED_SWAP_UNCLEAR', path: work.directory },
  );
}

const NO_SWAP_TO_FINISH: FinishedSwap = { outcome: 'none', notices: [] };

/** The swap stopped before its commit: the backup, the previous output, goes back. */
async function rollBackSwap({ fileSystem, work }: RecoveryRequest): Promise<FinishedSwap> {
  try {
    await restoreBackup(fileSystem, work);
  } catch (error) {
    throw publicationStepFailure(work.backup, error, 'the previous output stays in the backup');
  }
  const restored = {
    path: work.root,
    code: 'SWAP_ROLLED_BACK',
    message: 'An interrupted build had moved the output aside; it was put back.',
  };
  return { outcome: 'rolled-back', notices: [restored] };
}

/** The new root is in place, so the swap was committed: the backup goes to the trash. */
async function completeSwap({ fileSystem, work }: RecoveryRequest): Promise<FinishedSwap> {
  try {
    await moveBackupToTrash(fileSystem, work);
  } catch (error) {
    throw publicationStepFailure(work.backup, error, 'the published output stays as it is');
  }
  const completed = {
    path: work.root,
    code: 'SWAP_COMPLETED',
    message:
      'An interrupted build had already published its output; its leftover backup was moved to the trash.',
  };
  return { outcome: 'completed', notices: [completed] };
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  return (await entryKindAt(path)) === 'directory' && (await readdir(path)).length === 0;
}

/**
 * Whether the tree holds every file its own listing names with exactly the listed bytes, and its
 * marker, listing and manifest: only then is it a tree a swap moved in, never a damaged one.
 */
async function isCompleteTree(root: string, owner: OutputOwner): Promise<boolean> {
  const listing = await readGenerationListing(root);
  const manifest = await readOutputFile(join(root, RUNTIME_MANIFEST_NAME), MAX_TOOL_JSON_BYTES);
  if (listing === undefined || manifest.state !== 'present') return false;
  const toolFiles = [
    { name: OUTPUT_MARKER_NAME, text: outputMarkerTextOf(owner) },
    { name: GENERATION_LISTING_NAME, text: listing.text },
    { name: RUNTIME_MANIFEST_NAME, text: new TextDecoder().decode(manifest.bytes) },
  ];
  return (await auditOutputTree(root, { files: listing.files, toolFiles })).length === 0;
}

/**
 * Whether the root is the committed new root: a swap only ever moves in a complete, audited tree,
 * owned by this project and mode, with nothing the tool did not write; the backup is trashed
 * only then.
 */
async function isCommittedRoot({ work, owner }: RecoveryRequest): Promise<boolean> {
  const rootState = await assertReplaceableRoot(work.root, owner).catch(() => undefined);
  return rootState?.state === 'owned' && (await isCompleteTree(work.root, owner));
}

/** An empty root never came from a swap (someone recreated it): it goes, the backup goes back. */
async function rollBackOverEmptyRoot(request: RecoveryRequest): Promise<FinishedSwap> {
  const { fileSystem, work } = request;
  try {
    await fileSystem.rmdir(work.root);
  } catch (error) {
    throw publicationStepFailure(work.root, error, 'the previous output stays in the backup');
  }
  return rollBackSwap(request);
}

/** A backup next to a root: roll back over an empty root, complete a committed one, else refuse. */
async function finishNextToRoot(request: RecoveryRequest): Promise<FinishedSwap> {
  if (await isEmptyDirectory(request.work.root)) return rollBackOverEmptyRoot(request);
  if (await isCommittedRoot(request)) return completeSwap(request);
  throw unclear(
    request.work,
    'An interrupted swap left a backup next to an output that is not the new one',
  );
}

/** A swap stopped between its renames when its backup is there: the backup is the only truth. */
async function finishInterruptedSwap(request: RecoveryRequest): Promise<FinishedSwap> {
  const { work } = request;
  const backupKind = await entryKindAt(work.backup);
  if (backupKind === 'absent') return NO_SWAP_TO_FINISH;
  if (backupKind !== 'directory') {
    throw unclear(work, 'An interrupted swap left something other than a directory as its backup');
  }
  const isRootMissing = (await entryKindAt(work.root)) === 'absent';
  return isRootMissing ? rollBackSwap(request) : finishNextToRoot(request);
}

/** Removes a crashed build's staging and every tree in the trash; what stays is reported. */
async function removeLeftovers({ fileSystem, work }: RecoveryRequest): Promise<LeftoverRemoval> {
  const trashKind = await entryKindAt(work.trash);
  if (trashKind !== 'absent' && trashKind !== 'directory') {
    throw unclear(work, 'Something other than a directory is where the trash belongs');
  }
  const removals = [
    await removeOwnStaging(fileSystem, work.staging),
    await removeTrashedTrees(fileSystem, work.trash, ROOT_TOOL_FILE_NAMES),
  ];
  const { keptPaths, removedFileCount } = combinedRemoval(removals);
  return { notices: keptPathNotices(keptPaths), removedFileCount };
}

const NOTHING_RECOVERED: RecoveryResult = { outcome: 'none', notices: [], removedFileCount: 0 };

/**
 * Whether there is work an earlier build left: absent, or holding only build claims (this run's
 * among them), there is none; anything but a real directory cannot be told apart.
 */
async function hasEarlierWork(work: WorkDirectory): Promise<boolean> {
  const kind = await entryKindAt(work.directory);
  if (kind === 'absent') return false;
  if (kind !== 'directory') throw unclear(work, 'The work directory is not a real directory');
  const names = await readdir(work.directory);
  return !names.every((name) => name === OUTPUT_CLAIMS_DIRECTORY_NAME);
}

/**
 * Before a build touches its output, finishes what an earlier build left: a swap interrupted
 * between its renames is rolled back (the root is missing or an empty directory, so the backup
 * goes back) or completed (the committed new root is in place, so the backup goes to the trash);
 * a crashed build's staging and trash are removed, and the work directory too once empty.
 * Anything it cannot tell apart is refused untouched.
 */
export async function recoverWorkDirectory(request: RecoveryRequest): Promise<RecoveryResult> {
  const { work } = request;
  if (!(await hasEarlierWork(work))) return NOTHING_RECOVERED;
  const finished = await finishInterruptedSwap(request);
  const leftovers = await removeLeftovers(request);
  await removeEmptyWorkDirectory(request.fileSystem, work);
  return {
    outcome: finished.outcome,
    notices: [...finished.notices, ...leftovers.notices],
    removedFileCount: leftovers.removedFileCount,
  };
}
