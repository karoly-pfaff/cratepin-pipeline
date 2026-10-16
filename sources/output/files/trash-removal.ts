import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';
import { combinedRemoval, removeListedTree } from './tree-removal.ts';
import type { TreeRemoval } from './tree-removal.ts';

/** Every entry of a trash directory; none when it is missing, unreadable or not a real directory. */
async function trashedTreesIn(trash: string): Promise<string[]> {
  if ((await entryKindAt(trash)) !== 'directory') return [];
  const names = await readdir(trash).catch((): string[] => []);
  return names.toSorted(compareCodeUnits).map((name) => join(trash, name));
}

/**
 * Removes every tree in a trash directory as its listing proves it, one tree after another (an
 * entry that is not a real directory is kept), with `toolFileNames` the tool files such a tree
 * may hold; never fails. The trash directory itself stays.
 */
export async function removeTrashedTrees(
  fileSystem: PublicationFileSystem,
  trash: string,
  toolFileNames: readonly string[],
): Promise<TreeRemoval> {
  const removals: TreeRemoval[] = [];
  for (const tree of await trashedTreesIn(trash)) {
    removals.push(await removeListedTree(fileSystem, tree, toolFileNames));
  }
  return combinedRemoval(removals);
}

/** Removes the trash directory once it is empty; a link or anything else there is left alone. */
export async function removeEmptyTrash(
  fileSystem: PublicationFileSystem,
  trash: string,
): Promise<void> {
  if ((await entryKindAt(trash)) !== 'directory') return;
  await fileSystem.rmdir(trash).catch(() => undefined);
}
