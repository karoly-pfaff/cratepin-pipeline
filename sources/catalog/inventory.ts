import type { MediaCategory } from '../config/pipeline-config.ts';
import { PipelineError } from '../errors.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import { caseFoldedPath } from '../paths/portable-path.ts';
import { sortedByPath } from './ordering.ts';
import { groupsSharingKey, issuesForGroupMembers } from './source-issues.ts';
import type { SourceIssue } from './source-issues.ts';
import { readCandidates } from './source-reading.ts';
import { classifySources, selectIncludedFiles } from './source-selection.ts';
import { listSourceTree } from './source-tree.ts';

/** One original as found on disk: its raw bytes' SHA-256 and length, before any processing. */
export interface InventoryEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly category: MediaCategory;
}

/** Every selected original sorted by path, and every finding sorted by path and code. */
export interface SourceInventory {
  readonly entries: readonly InventoryEntry[];
  readonly issues: readonly SourceIssue[];
}

async function assertSourceRootExists(sourceRoot: string): Promise<void> {
  if ((await entryKindAt(sourceRoot)) === 'directory') return;
  throw new PipelineError('NOT_FOUND', 'The source directory does not exist.', { sourceRoot });
}

/** Paths that would be one file on a case-insensitive or normalizing file system. */
export function caseCollisionIssues(paths: readonly string[]): SourceIssue[] {
  return issuesForGroupMembers(groupsSharingKey(paths, caseFoldedPath), 'CASE_COLLISION');
}

function duplicateContentIssues(entries: readonly InventoryEntry[]): SourceIssue[] {
  const groups = groupsSharingKey(entries, (entry) => entry.sha256);
  const pathGroups = groups.map((group) => group.map((entry) => entry.path));
  return issuesForGroupMembers(pathGroups, 'DUPLICATE_CONTENT');
}

/**
 * Lists, classifies and hashes the originals the configuration selects. Only reads: nothing is
 * written, moved or deleted, and no network or credential is touched. Files the include patterns
 * do not select are never opened.
 */
export async function inventorySources(project: CheckedProject): Promise<SourceInventory> {
  const { config, paths } = project;
  await assertSourceRootExists(paths.sourceRoot);
  const tree = await listSourceTree(paths.sourceRoot);
  const included = selectIncludedFiles(tree.files, config.sources.include);
  const classified = classifySources(included.accepted, config);
  const read = await readCandidates(
    classified.accepted,
    paths.sourceRoot,
    config.limits.maxSourceBytes,
  );
  const issues = [
    ...tree.issues,
    ...included.issues,
    ...classified.issues,
    ...caseCollisionIssues(included.accepted),
    ...read.issues,
    ...duplicateContentIssues(read.accepted),
  ];
  return { entries: sortedByPath(read.accepted), issues: sortedByPath(issues) };
}
