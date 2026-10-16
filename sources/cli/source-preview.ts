import { catalogSources } from '../catalog/asset-catalog.ts';
import type { CatalogedAsset, SourceCatalog } from '../catalog/asset-catalog.ts';
import { inventorySources } from '../catalog/inventory.ts';
import { sortedByPath } from '../catalog/ordering.ts';
import { isBlockingIssue } from '../catalog/source-issues.ts';
import type { SourceIssue } from '../catalog/source-issues.ts';
import { PipelineError } from '../errors.ts';
import { identityChangeNotices, sourcesMissingIssues } from '../lock/change-checks.ts';
import { diffLocks } from '../lock/lock-diff.ts';
import type { LockDiff } from '../lock/lock-diff.ts';
import { loadCommittedLock } from '../lock/lock-file.ts';
import type { LockLoad } from '../lock/lock-file.ts';
import type { LockIssue } from '../lock/lock-validation.ts';
import { stageLock } from '../lock/source-lock.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { failedReport } from '../report.ts';
import type { OperationReport, ReportFacts, ReportRecord } from '../report.ts';

/** The local sources compared with the committed lock; nothing is written or uploaded. */
export interface SourcePreview {
  readonly catalog: SourceCatalog;
  readonly committed: SourceLock | undefined;
  readonly staged: SourceLock;
  readonly diff: LockDiff;
}

export type PreviewOutcome =
  | { readonly ok: true; readonly preview: SourcePreview }
  | { readonly ok: false; readonly report: OperationReport };

/** The asset as a listing row that starts with its ID, the field readers look for first. */
function withIdFirst({ id, ...described }: CatalogedAsset): ReportRecord {
  return { id, ...described };
}

export function catalogFacts(project: CheckedProject, catalog: SourceCatalog): ReportFacts {
  return {
    projectId: project.config.projectId,
    sourceRoot: project.paths.sourceRoot,
    assetCount: catalog.assets.length,
    totalBytes: catalog.assets.reduce((total, asset) => total + asset.bytes, 0),
    assets: catalog.assets.map(withIdFirst),
  };
}

/** Which IDs a new lock would add, change or drop; dropping an ID never deletes stored bytes. */
export function changeFacts(diff: LockDiff): ReportFacts {
  return {
    addedIds: diff.added.map((record) => record.id),
    changed: diff.changed.map(({ after, changedFields }) => ({ id: after.id, changedFields })),
    removedIds: diff.removed.map((record) => record.id),
    identityChanges: diff.identityChanges.map(({ from, to }) => ({ fromId: from.id, toId: to.id })),
    unchangedCount: diff.unchanged.length,
  };
}

export function invalidLockError(issues: readonly LockIssue[]): PipelineError {
  return new PipelineError('INVALID_DATA', 'The committed lock file is invalid.', {
    issueCount: issues.length,
  });
}

function unusableSourcesError(issues: readonly SourceIssue[]): PipelineError {
  return new PipelineError('INVALID_DATA', 'Some sources or assets entries cannot be used.', {
    issueCount: issues.filter(isBlockingIssue).length,
  });
}

/** Catalogs the sources and adds the empty-tree check against the committed lock. */
async function catalogAgainstLock(
  project: CheckedProject,
  committed: SourceLock | undefined,
): Promise<SourceCatalog> {
  const catalog = catalogSources(await inventorySources(project), project.config.assets);
  const issues = [...catalog.issues, ...sourcesMissingIssues(committed, catalog.assets.length)];
  return { assets: catalog.assets, issues: sortedByPath(issues) };
}

/** Stages the lock of a usable catalog and compares it with the committed one. */
function stagedPreview(
  project: CheckedProject,
  catalog: SourceCatalog,
  committed: SourceLock | undefined,
): PreviewOutcome {
  const staged = stageLock(project.config, catalog);
  const diff = diffLocks(committed, staged);
  const issues = sortedByPath([...catalog.issues, ...identityChangeNotices(diff)]);
  return { ok: true, preview: { catalog: { ...catalog, issues }, committed, staged, diff } };
}

interface PreviewFailure {
  readonly error: PipelineError;
  readonly issues: readonly (SourceIssue | LockIssue)[];
}

/** An invalid committed lock first, then any blocking source finding; none means usable. */
function previewFailureOf(lockLoad: LockLoad, catalog: SourceCatalog): PreviewFailure | undefined {
  if (lockLoad.status === 'invalid') {
    return { error: invalidLockError(lockLoad.issues), issues: lockLoad.issues };
  }
  if (!catalog.issues.some(isBlockingIssue)) return undefined;
  return { error: unusableSourcesError(catalog.issues), issues: catalog.issues };
}

/**
 * Inventories and catalogs the sources, reads the committed lock and stages the lock they would
 * produce. An invalid lock or a blocking finding ends the preview with a failed report that
 * still lists the catalog.
 */
export async function previewSources(
  command: string,
  project: CheckedProject,
): Promise<PreviewOutcome> {
  const lockLoad = await loadCommittedLock(project);
  const committed = lockLoad.status === 'valid' ? lockLoad.lock : undefined;
  const catalog = await catalogAgainstLock(project, committed);
  const failure = previewFailureOf(lockLoad, catalog);
  if (failure === undefined) return stagedPreview(project, catalog, committed);
  const listing = { facts: catalogFacts(project, catalog), issues: failure.issues };
  return { ok: false, report: failedReport(command, failure.error, listing) };
}
