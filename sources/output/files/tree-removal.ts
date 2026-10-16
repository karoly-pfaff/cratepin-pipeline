import { join } from 'node:path';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import { GENERATION_LISTING_NAME } from '../generation/generation-listing.ts';
import type { ListedFile } from '../generation/generation-listing.ts';
import { readGenerationListing } from '../generation/listing-reading.ts';
import type { PublishedListing } from '../generation/listing-reading.ts';
import { checkOutputFile, directoriesLeadingTo } from './output-files.ts';
import { OUTPUT_MARKER_NAME } from '../ownership/output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';
import type { ReportIssue } from '../../report.ts';
import { walkTree } from './tree-audit.ts';

/**
 * The tool files at the top of a path-preserving root, the listing last (it proves the rest).
 * A generation holds only its listing; nothing else at those names in it is ever removed.
 */
export const ROOT_TOOL_FILE_NAMES = [
  RUNTIME_MANIFEST_NAME,
  OUTPUT_MARKER_NAME,
  GENERATION_LISTING_NAME,
];
export const GENERATION_TOOL_FILE_NAMES = [GENERATION_LISTING_NAME];

/** What a removal did: the files it removed and every path it kept (which a later run retries). */
export interface TreeRemoval {
  readonly removedFileCount: number;
  readonly keptPaths: readonly string[];
}

function pathIn(tree: string, relative: string): string {
  return join(tree, ...relative.split('/'));
}

/** Runs one removal; false when it failed (open, already gone, not empty), which keeps the entry. */
async function removed(operation: () => Promise<void>): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
}

/** Directories deepest first, so each is empty by the time it is removed. */
function deepestFirst(directories: readonly string[]): string[] {
  const depth = (path: string): number => path.split('/').length;
  return [...new Set(directories)].toSorted(
    (left, right) => depth(right) - depth(left) || compareCodeUnits(left, right),
  );
}

/** Removes the directories below `tree` that are empty, deepest first; the tree itself stays. */
async function removeEmptyDirectoriesBelow(
  fileSystem: PublicationFileSystem,
  tree: string,
  directories: readonly string[],
): Promise<void> {
  for (const directory of deepestFirst(directories)) {
    const path = pathIn(tree, directory);
    if ((await entryKindAt(path)) === 'directory') await removed(() => fileSystem.rmdir(path));
  }
}

async function removeEmptyDirectories(
  fileSystem: PublicationFileSystem,
  tree: string,
  directories: readonly string[],
): Promise<void> {
  await removeEmptyDirectoriesBelow(fileSystem, tree, directories);
  await removed(() => fileSystem.rmdir(tree));
}

async function pathsLeftIn(tree: string): Promise<string[]> {
  const kind = await entryKindAt(tree);
  if (kind === 'absent') return [];
  if (kind !== 'directory') return [tree];
  const { files, directories, others } = await walkTree(tree);
  const left = [...files, ...directories, ...others].map((path) => pathIn(tree, path));
  return left.length === 0 ? [tree] : left.toSorted(compareCodeUnits);
}

/** Every path still at or below `tree`, or none once it is gone; the tree itself if unreadable. */
async function keptPathsIn(tree: string): Promise<string[]> {
  return pathsLeftIn(tree).catch(() => [tree]);
}

async function isVerifiedListedFile(tree: string, file: ListedFile): Promise<boolean> {
  for (const directory of directoriesLeadingTo(file.path)) {
    if ((await entryKindAt(pathIn(tree, directory))) !== 'directory') return false;
  }
  return (await checkOutputFile(pathIn(tree, file.path), file)) === 'verified';
}

/**
 * A listed file is removed only through real directories and only while it holds its bytes; one
 * that cannot even be inspected (open without sharing, unreadable) stays.
 */
async function isUnchangedListedFile(tree: string, file: ListedFile): Promise<boolean> {
  return isVerifiedListedFile(tree, file).catch(() => false);
}

async function removeListedOutputs(
  fileSystem: PublicationFileSystem,
  tree: string,
  files: readonly ListedFile[],
): Promise<number> {
  let count = 0;
  for (const file of files) {
    const isRemovable = await isUnchangedListedFile(tree, file);
    if (isRemovable && (await removed(() => fileSystem.unlink(pathIn(tree, file.path)))))
      count += 1;
  }
  return count;
}

/** Whether no listed path is left: neither a listed file nor a directory leading to one. */
async function isEveryListedPathGone(tree: string, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if ((await entryKindAt(pathIn(tree, path))) !== 'absent') return false;
  }
  return true;
}

/**
 * The tool's own files at the top of a tree, the listing last: it is what proves the rest, so
 * when one of them cannot be removed the removal stops there and the listing stays for a later
 * run to finish with.
 */
async function removeToolFiles(
  fileSystem: PublicationFileSystem,
  tree: string,
  toolFileNames: readonly string[],
): Promise<number> {
  let count = 0;
  for (const name of toolFileNames) {
    if ((await entryKindAt(join(tree, name))) !== 'file') continue;
    if (!(await removed(() => fileSystem.unlink(join(tree, name))))) return count;
    count += 1;
  }
  return count;
}

/** The listing of a real directory, or `undefined` for a link, anything else or a bad listing. */
async function listingOfRealDirectory(tree: string): Promise<PublishedListing | undefined> {
  if ((await entryKindAt(tree)) !== 'directory') return undefined;
  return readGenerationListing(tree).catch(() => undefined);
}

/** A tree without a listing is removed only if it is an empty real directory; else it stays. */
async function removeUnlistedTree(
  fileSystem: PublicationFileSystem,
  tree: string,
): Promise<TreeRemoval> {
  if ((await entryKindAt(tree)) === 'directory') await removed(() => fileSystem.rmdir(tree));
  return { removedFileCount: 0, keptPaths: await keptPathsIn(tree) };
}

/** Every listed file and every directory leading to one. */
function listedPathsOf(files: readonly ListedFile[]): string[] {
  return [
    ...files.map(({ path }) => path),
    ...files.flatMap(({ path }) => directoriesLeadingTo(path)),
  ];
}

/** The listed files that still hold their bytes, then the listed directories that became empty. */
async function removeListedOutputsAndDirectories(
  fileSystem: PublicationFileSystem,
  tree: string,
  files: readonly ListedFile[],
): Promise<number> {
  const count = await removeListedOutputs(fileSystem, tree, files);
  const directories = files.flatMap(({ path }) => directoriesLeadingTo(path));
  await removeEmptyDirectoriesBelow(fileSystem, tree, directories);
  return count;
}

/**
 * Removes a tree the tool published (an old root or generation in the trash), never recursively
 * and never through a link: each file its listing names, only while it still holds exactly the
 * listed bytes, then the listed directories that became empty (only real directories; a link in
 * their place stays), then, once every listed file and directory is gone, the tool's own files
 * with the listing last, so a later run can still prove and finish what is left. Anything else
 * (an unlisted, changed or unreadable file, a link, a file still open) stays and is reported; a
 * tree without a readable listing is kept whole unless it is empty. It never fails: what it
 * cannot remove it keeps.
 */
export async function removeListedTree(
  fileSystem: PublicationFileSystem,
  tree: string,
  toolFileNames: readonly string[] = ROOT_TOOL_FILE_NAMES,
): Promise<TreeRemoval> {
  const listing = await listingOfRealDirectory(tree);
  if (listing === undefined) return removeUnlistedTree(fileSystem, tree);
  const outputs = await removeListedOutputsAndDirectories(fileSystem, tree, listing.files);
  const isProofSpent = await isEveryListedPathGone(tree, listedPathsOf(listing.files));
  const toolFiles = isProofSpent ? await removeToolFiles(fileSystem, tree, toolFileNames) : 0;
  await removed(() => fileSystem.rmdir(tree));
  return { removedFileCount: outputs + toolFiles, keptPaths: await keptPathsIn(tree) };
}

/** Removes each file below `tree`; how many went. */
async function removeFiles(
  fileSystem: PublicationFileSystem,
  tree: string,
  files: readonly string[],
): Promise<number> {
  let count = 0;
  for (const file of files) {
    if (await removed(() => fileSystem.unlink(pathIn(tree, file)))) count += 1;
  }
  return count;
}

/**
 * Removes the tool's own staging directory, which was never published: every regular file and
 * real directory in it, deepest first. A link, junction or other special entry is never followed
 * or removed; it stays and is reported, and so do its parents.
 */
export async function removeOwnStaging(
  fileSystem: PublicationFileSystem,
  staging: string,
): Promise<TreeRemoval> {
  const kind = await entryKindAt(staging);
  if (kind !== 'directory')
    return { removedFileCount: 0, keptPaths: kind === 'absent' ? [] : [staging] };
  const walked = await walkTree(staging).catch(() => undefined);
  if (walked === undefined) return { removedFileCount: 0, keptPaths: [staging] };
  const removedFileCount = await removeFiles(fileSystem, staging, walked.files);
  await removeEmptyDirectories(fileSystem, staging, walked.directories);
  return { removedFileCount, keptPaths: await keptPathsIn(staging) };
}

/** All the removals together: every file removed and every path kept. */
export function combinedRemoval(removals: readonly TreeRemoval[]): TreeRemoval {
  return {
    removedFileCount: removals.reduce((total, removal) => total + removal.removedFileCount, 0),
    keptPaths: removals.flatMap((removal) => removal.keptPaths),
  };
}

/** One notice per path a removal kept (staging, trash or a temporary manifest). */
export function keptPathNotices(keptPaths: readonly string[]): ReportIssue[] {
  return keptPaths.map((path) => ({
    path,
    code: 'OUTPUT_TRASH_KEPT',
    message:
      'Left in the output (staging, trash or a temporary manifest): open, changed or not written by the tool, or the listing that proves the rest. A later build retries a file that was open; check and remove anything else by hand.',
  }));
}
