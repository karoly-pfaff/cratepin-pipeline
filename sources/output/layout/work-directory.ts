import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ensureDirectory } from '../../paths/files/create-only-files.ts';
import { outputWorkDirectoryOf } from '../../paths/layout/output-work-directory.ts';
import { renameWithRetry } from '../publication/publication-files.ts';
import { removeEmptyTrash } from '../files/trash-removal.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';

/**
 * The tool's one hidden directory next to an output root, on the same volume so
 * renames between them are single steps, e.g. `public/.assets.cratepin/` for
 * `public/assets`. It holds `staging/` (the next root, being written), `backup/` (the previous
 * root, present only while a swap is in flight: its presence marks an interrupted swap) and
 * `trash/<uuid>/` (an old root being removed), and `claims/` while a build holds the root. The
 * build claim keeps these names to one run.
 */
export interface WorkDirectory {
  readonly root: string;
  readonly directory: string;
  readonly staging: string;
  readonly backup: string;
  readonly trash: string;
  /** Build claims on the root, of any config publishing into it. */
  readonly claims: string;
}

export const OUTPUT_CLAIMS_DIRECTORY_NAME = 'claims';

export function workDirectoryOf(outputRoot: string): WorkDirectory {
  const directory = outputWorkDirectoryOf(outputRoot);
  return {
    root: outputRoot,
    directory,
    staging: join(directory, 'staging'),
    backup: join(directory, 'backup'),
    trash: join(directory, 'trash'),
    claims: join(directory, OUTPUT_CLAIMS_DIRECTORY_NAME),
  };
}

/** A new, unique place in the trash for one old tree. */
export function trashPathOf(work: WorkDirectory): string {
  return join(work.trash, randomUUID());
}

/** Puts the backup (the previous root) back in the root's place. */
export function restoreBackup(
  fileSystem: PublicationFileSystem,
  work: WorkDirectory,
): Promise<void> {
  return renameWithRetry(fileSystem, work.backup, work.root);
}

/** Moves the backup (an old root) to a new place in the trash; returns that place. */
export async function moveBackupToTrash(
  fileSystem: PublicationFileSystem,
  work: WorkDirectory,
): Promise<string> {
  const trash = trashPathOf(work);
  await ensureDirectory(work.trash);
  await renameWithRetry(fileSystem, work.backup, trash);
  return trash;
}

/**
 * Removes the trash and then the work directory once they are empty, so a finished build leaves
 * nothing next to the output; whatever is still in them stays for a later build.
 */
export async function removeEmptyWorkDirectory(
  fileSystem: PublicationFileSystem,
  work: WorkDirectory,
): Promise<void> {
  await removeEmptyTrash(fileSystem, work.trash);
  await fileSystem.rmdir(work.directory).catch(() => undefined);
}
