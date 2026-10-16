import { readdir } from 'node:fs/promises';

import { PipelineError } from '../../errors.ts';
import { entryKindAt, isAbsentEntryError } from '../../paths/path-containment.ts';
import type { GenerationLayout } from './generation-layout.ts';
import { isGenerationsUsable } from './generation-root.ts';
import { classifyOutputRoot } from '../ownership/output-marker.ts';
import type { OutputOwner } from '../ownership/output-marker.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';
import type { RecoveryResult } from '../publication/output-recovery.ts';
import { removeEmptyTrash, removeTrashedTrees } from '../files/trash-removal.ts';
import {
  combinedRemoval,
  GENERATION_TOOL_FILE_NAMES,
  keptPathNotices,
  removeOwnStaging,
} from '../files/tree-removal.ts';
import type { TreeRemoval } from '../files/tree-removal.ts';
import { OUTPUT_CLAIMS_DIRECTORY_NAME } from '../layout/work-directory.ts';
import type { WorkDirectory } from '../layout/work-directory.ts';

function noNames(error: unknown): string[] {
  if (isAbsentEntryError(error)) return [];
  throw error;
}

/**
 * Whether the work directory holds no path-preserving work: absent, only claims, or not a real
 * directory at all (`workDirectoryRefusal` refuses a link or file there first). One another
 * build's release removed meanwhile holds nothing.
 */
async function holdsNoPathPreservingWork(work: WorkDirectory): Promise<boolean> {
  if ((await entryKindAt(work.directory)) !== 'directory') return true;
  const names = await readdir(work.directory).catch(noNames);
  return names.every((name) => name === OUTPUT_CLAIMS_DIRECTORY_NAME);
}

/** Why a generation build stops at a path-preserving build's work next to the root. */
export const PATH_PRESERVING_WORK_LEFT = 'PATH_PRESERVING_WORK_LEFT';

/**
 * Generation builds keep only their claims in the work directory next to the root. Anything else
 * there is a path-preserving build's, from before the mode changed: it would ship, and this mode
 * can neither finish nor remove it, so a build stops before touching anything and says how to
 * clear it. Read only.
 */
export async function pathPreservingWorkError(
  work: WorkDirectory,
): Promise<PipelineError | undefined> {
  if (await holdsNoPathPreservingWork(work)) return undefined;
  return new PipelineError(
    'OUTPUT_CONFLICT',
    `A path-preserving build left work next to the output root, which generation mode cannot finish; nothing was changed. Build once in path-preserving mode to recover it, or remove ${work.directory}.`,
    { reason: PATH_PRESERVING_WORK_LEFT, path: work.directory },
  );
}

/** Removes a manifest a build wrote but never switched in; it never counted. */
async function removeManifestInProgress(
  fileSystem: PublicationFileSystem,
  layout: GenerationLayout,
): Promise<TreeRemoval> {
  const kind = await entryKindAt(layout.manifestInProgress);
  if (kind === 'absent') return { removedFileCount: 0, keptPaths: [] };
  const isRemoved =
    kind === 'file' &&
    (await fileSystem.unlink(layout.manifestInProgress).then(
      () => true,
      () => false,
    ));
  return isRemoved
    ? { removedFileCount: 1, keptPaths: [] }
    : { removedFileCount: 0, keptPaths: [layout.manifestInProgress] };
}

const NOTHING_RECOVERED: RecoveryResult = { outcome: 'none', notices: [], removedFileCount: 0 };

/** Recovery works only in a root owned by this project and mode, with a real `generations/`. */
export async function isRecoverable(
  layout: GenerationLayout,
  owner: OutputOwner,
): Promise<boolean> {
  const { state } = await classifyOutputRoot(layout.root, owner);
  return state === 'owned' && (await isGenerationsUsable(layout));
}

/**
 * Before a generation-mode build touches its output, removes what an interrupted one left. The
 * root manifest is the only truth, so nothing is rolled back or completed: a staging that was
 * never placed, a manifest that was never switched in and every tree in the trash are removed
 * (the trash as its listings prove it); what stays is reported. Generations are never touched.
 * Nothing at all is done unless the root is this project's and mode's and `generations/` is a
 * real directory: the build refuses any other root right after.
 */
export async function recoverGenerationRoot(
  fileSystem: PublicationFileSystem,
  layout: GenerationLayout,
  owner: OutputOwner,
): Promise<RecoveryResult> {
  if (!(await isRecoverable(layout, owner))) return NOTHING_RECOVERED;
  const removals = [
    await removeOwnStaging(fileSystem, layout.staging),
    await removeManifestInProgress(fileSystem, layout),
    await removeTrashedTrees(fileSystem, layout.trash, GENERATION_TOOL_FILE_NAMES),
  ];
  await removeEmptyTrash(fileSystem, layout.trash);
  const { keptPaths, removedFileCount } = combinedRemoval(removals);
  return { outcome: 'none', notices: keptPathNotices(keptPaths), removedFileCount };
}
