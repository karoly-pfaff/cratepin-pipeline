import { sortedByPath } from '../../catalog/ordering.ts';
import { PipelineError } from '../../errors.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import { totalBytes } from '../../lock/upload-plan.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import type {
  CacheInspection,
  OriginalOutcome,
  OriginalStatus,
} from '../../pull/locked-originals.ts';
import type { PullPreview, PullResult } from '../../pull/pull-run.ts';
import type { SourceRestorePlan, SourceRestoreResult } from '../../pull/source-restore.ts';
import { failedReport, succeededReport } from '../../report.ts';
import type { OperationReport, ReportFacts, ReportIssue } from '../../report.ts';
import {
  cacheMissIssue,
  corruptEntryNotice,
  failureIssue,
  keptSourceNotice,
  recordOutcomes,
  restoreSkippedNotice,
} from './pull-issues.ts';
import type { RecordOutcome } from './pull-issues.ts';

const COMMAND = 'pull';

/** The project, lock and modes a pull report describes. */
export interface PulledProject {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
  readonly isOffline: boolean;
  readonly isRestoringSources: boolean;
}

function locationFacts({ project }: PulledProject): ReportFacts {
  return {
    projectId: project.config.projectId,
    cacheRoot: project.paths.cacheRoot,
    lockFilePath: project.paths.lockFilePath,
  };
}

function withStatus(
  outcomes: readonly OriginalOutcome[],
  status: OriginalStatus,
): OriginalOutcome[] {
  return outcomes.filter((outcome) => outcome.status === status);
}

export function retrievalFacts(outcomes: readonly OriginalOutcome[]): ReportFacts {
  const downloaded = withStatus(outcomes, 'downloaded').map((outcome) => outcome.object);
  return {
    objectCount: outcomes.length,
    cachedCount: withStatus(outcomes, 'cached').length,
    downloadedCount: downloaded.length,
    downloadedBytes: totalBytes(downloaded),
    quarantinedCount: outcomes.filter((outcome) => outcome.wasQuarantined).length,
  };
}

function restoreFacts(restore: SourceRestoreResult | undefined): ReportFacts {
  if (restore === undefined) return {};
  return {
    restoredSources: restore.restored,
    unchangedSourceCount: restore.unchanged.length,
    keptSources: restore.kept,
  };
}

/** The per-ID issues of a retrieval: corrupt entries quarantined, misses and failures. */
export function retrievalIssuesOf(
  lock: SourceLock,
  outcomes: readonly OriginalOutcome[],
): ReportIssue[] {
  return recordOutcomes(lock, outcomes).flatMap(issueOf);
}

function issueOf({ record, outcome }: RecordOutcome<OriginalOutcome>): ReportIssue[] {
  const quarantined = outcome.wasQuarantined
    ? [corruptEntryNotice(record, 'was moved to the quarantine')]
    : [];
  if (outcome.status === 'missing') return [...quarantined, cacheMissIssue(record)];
  if (outcome.error !== undefined) return [...quarantined, failureIssue(record, outcome.error)];
  return quarantined;
}

function offlineMissError(missingCount: number): PipelineError {
  return new PipelineError(
    'NOT_FOUND',
    `${String(missingCount)} locked originals are not in the cache; offline mode downloads nothing.`,
    { missingCount },
  );
}

/** The error of a pull that left originals out: offline misses, or the first failed ID's code. */
export function retrievalFailureOf(
  pairs: readonly RecordOutcome<OriginalOutcome>[],
  outcomes: readonly OriginalOutcome[],
): PipelineError | undefined {
  const missingCount = withStatus(outcomes, 'missing').length;
  if (missingCount > 0) return offlineMissError(missingCount);
  const firstError = pairs.find(({ outcome }) => outcome.error !== undefined)?.outcome.error;
  if (firstError === undefined) return undefined;
  const failedCount = withStatus(outcomes, 'failed').length;
  const message = `${String(failedCount)} of ${String(outcomes.length)} locked originals could not be retrieved; see the issues.`;
  return new PipelineError(firstError.code, message, { failedCount });
}

/** Kept sources, or why a requested restore did not run at all. */
function restoreNoticesOf(pulled: PulledProject, result: PullResult): ReportIssue[] {
  if (result.restore !== undefined) return result.restore.kept.map(keptSourceNotice);
  return pulled.isRestoringSources ? [restoreSkippedNotice()] : [];
}

/**
 * The report of a pull: what is cached now, what failed per ID, and what a restore did. A
 * restore that stopped early fails the report with its error, still listing everything else.
 */
export function pullReport(pulled: PulledProject, result: PullResult): OperationReport {
  const pairs = recordOutcomes(pulled.lock, result.originals);
  const issues = sortedByPath([...pairs.flatMap(issueOf), ...restoreNoticesOf(pulled, result)]);
  const facts = {
    ...locationFacts(pulled),
    ...retrievalFacts(result.originals),
    ...restoreFacts(result.restore),
  };
  const failure = retrievalFailureOf(pairs, result.originals) ?? result.restore?.error;
  return failure === undefined
    ? succeededReport(COMMAND, facts, issues)
    : failedReport(COMMAND, failure, { facts, issues });
}

function restorePlanFacts(plan: SourceRestorePlan | undefined): ReportFacts {
  if (plan === undefined) return {};
  return {
    wouldRestoreSources: plan.missing.map((record) => record.source),
    unchangedSourceCount: plan.unchanged.length,
    keptSources: plan.kept,
  };
}

/** What an online pull would download; offline, nothing is. */
function downloadPlanFacts(notCached: readonly CacheInspection[]): ReportFacts {
  return {
    wouldDownload: notCached.map(({ object }) => ({ ...object })),
    wouldDownloadBytes: totalBytes(notCached.map((inspection) => inspection.object)),
  };
}

/** Offline, a missing original means the restore would not run at all. */
function wouldRestore(pulled: PulledProject, notCached: readonly CacheInspection[]): boolean {
  return pulled.isRestoringSources && (!pulled.isOffline || notCached.length === 0);
}

/** Corrupt entries a pull would quarantine, and sources a restore would keep or skip. */
function previewNoticesOf(
  pulled: PulledProject,
  preview: PullPreview,
  notCached: readonly CacheInspection[],
): ReportIssue[] {
  const consequence = pulled.isOffline ? 'would be quarantined' : 'would be fetched again';
  const corrupt = recordOutcomes(pulled.lock, preview.inspections)
    .filter(({ outcome }) => outcome.state === 'corrupt')
    .map(({ record }) => corruptEntryNotice(record, consequence));
  const restore = wouldRestore(pulled, notCached)
    ? (preview.restorePlan?.kept.map(keptSourceNotice) ?? [])
    : [restoreSkippedNotice()];
  return sortedByPath([...corrupt, ...(pulled.isRestoringSources ? restore : [])]);
}

/** The report of `pull --dry-run`: what a pull would download, quarantine and restore. */
export function pullPreviewReport(pulled: PulledProject, preview: PullPreview): OperationReport {
  const notCached = preview.inspections.filter((inspection) => inspection.state !== 'verified');
  const facts = {
    ...locationFacts(pulled),
    objectCount: preview.inspections.length,
    cachedCount: preview.inspections.length - notCached.length,
    ...(pulled.isOffline ? {} : downloadPlanFacts(notCached)),
    ...(wouldRestore(pulled, notCached) ? restorePlanFacts(preview.restorePlan) : {}),
  };
  const issues = previewNoticesOf(pulled, preview, notCached);
  if (!pulled.isOffline || notCached.length === 0) return succeededReport(COMMAND, facts, issues);
  return offlinePreviewFailure(pulled, notCached, { facts, issues });
}

function offlinePreviewFailure(
  pulled: PulledProject,
  notCached: readonly CacheInspection[],
  context: { readonly facts: ReportFacts; readonly issues: readonly ReportIssue[] },
): OperationReport {
  const missing = new Set(notCached.map(({ object }) => object.objectKey));
  const misses = pulled.lock.assets
    .filter((record) => missing.has(record.objectKey))
    .map(cacheMissIssue);
  const issues = sortedByPath([...context.issues, ...misses]);
  return failedReport(COMMAND, offlineMissError(missing.size), { facts: context.facts, issues });
}
