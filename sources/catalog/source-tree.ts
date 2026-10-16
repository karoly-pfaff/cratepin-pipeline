import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { sourceIssue, unreadableIssue } from './source-issues.ts';
import type { SourceIssue } from './source-issues.ts';

/** Every regular file visible under the source root, as forward-slash relative paths. */
export interface SourceTreeListing {
  readonly files: readonly string[];
  /** Links, junctions, special files and unreadable directories found on the way. */
  readonly issues: readonly SourceIssue[];
}

interface ListingInProgress {
  readonly files: string[];
  readonly issues: SourceIssue[];
  readonly directoriesToVisit: string[];
}

/** Hidden entries such as `.env`, `.git` or `.DS_Store` are never listed, read or searched. */
function isHidden(entry: Dirent): boolean {
  return entry.name.startsWith('.');
}

async function readDirectory(
  sourceRoot: string,
  directory: string,
  listing: ListingInProgress,
): Promise<Dirent[]> {
  try {
    return await readdir(join(sourceRoot, ...directory.split('/')), { withFileTypes: true });
  } catch (error) {
    listing.issues.push(unreadableIssue(directory === '' ? '.' : directory, error));
    return [];
  }
}

function recordEntry(entry: Dirent, directory: string, listing: ListingInProgress): void {
  if (isHidden(entry)) return;
  const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
  if (entry.isDirectory()) listing.directoriesToVisit.push(path);
  else if (entry.isFile()) listing.files.push(path);
  else listing.issues.push(sourceIssue(path, 'NOT_A_REGULAR_FILE'));
}

/**
 * Lists the source tree without following links: a junction or symbolic link is an issue, so
 * nothing outside the source root can be pulled in through one, and a directory that cannot be
 * read is an issue rather than a silent gap.
 */
export async function listSourceTree(sourceRoot: string): Promise<SourceTreeListing> {
  const listing: ListingInProgress = { files: [], issues: [], directoriesToVisit: [''] };
  let directory = listing.directoriesToVisit.pop();
  while (directory !== undefined) {
    for (const entry of await readDirectory(sourceRoot, directory, listing)) {
      recordEntry(entry, directory, listing);
    }
    directory = listing.directoriesToVisit.pop();
  }
  return { files: listing.files, issues: listing.issues };
}
