import type { Invocation } from '../arguments.ts';
import { runWithCheckedProject } from '../checked-project-run.ts';
import type { CommandRuntime } from '../command-runtime.ts';
import { planPush } from './push-plan-command.ts';
import { changeFacts, previewSources } from '../source-preview.ts';
import type { PreviewOutcome, SourcePreview } from '../source-preview.ts';
import { PipelineError, throwIfCancelled } from '../../errors.ts';
import type { LockDiff } from '../../lock/lock-diff.ts';
import { lockDigest } from '../../lock/source-lock.ts';
import { totalBytes } from '../../lock/upload-plan.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { pushStagedLock } from '../../push/push-run.ts';
import type { PushRequest, PushResult } from '../../push/push-run.ts';
import { failedReport, succeededReport } from '../../report.ts';
import type { OperationReport, ReportFacts, ReportIssue } from '../../report.ts';
import { createR2BlobReader, createR2BlobWriter } from '../../storage/r2/r2-blob-store.ts';
import { resolveR2Connection } from '../../storage/r2/r2-connection.ts';
import { transferSettingsFrom } from '../../storage/transfer/transfer-settings.ts';

type PushContext = Omit<PushRequest, 'storage'>;

/** Removing IDs from the lock needs a deliberate --confirm-removals; their bytes stay stored. */
function unconfirmedRemovalsReport(diff: LockDiff): OperationReport {
  const issues: ReportIssue[] = diff.removed.map((record) => ({
    path: record.source,
    code: 'REMOVAL_UNCONFIRMED',
    message: `The new lock would no longer list "${record.id}"; its stored original stays.`,
  }));
  const unconfirmed = new PipelineError(
    'INVALID_DATA',
    'The push would remove IDs from the lock; check them and rerun with --confirm-removals.',
    { removedCount: issues.length },
  );
  return failedReport('push', unconfirmed, { facts: changeFacts(diff), issues });
}

/**
 * Writer credentials, resolved only now. Objects go up `concurrency` at a time with their parts
 * one by one, so memory holds about two parts per object: the one being sent, the next being read.
 */
function storageFor(context: PushContext, runtime: CommandRuntime): PushRequest['storage'] {
  const { config } = context.project;
  const connection = resolveR2Connection(config.r2, 'write', runtime);
  const settings = {
    ...transferSettingsFrom(config.limits, context.concurrency),
    partConcurrency: 1,
  };
  return {
    writer: createR2BlobWriter(connection, settings),
    reader: createR2BlobReader(connection, settings),
  };
}

function progressFacts(result: PushResult): ReportFacts {
  return {
    createdCount: result.created.length,
    createdBytes: totalBytes(result.created),
    alreadyStoredCount: result.alreadyStored.length,
    confirmedCount: result.confirmed.length,
  };
}

function pushReport(project: CheckedProject, result: PushResult, diff: LockDiff): OperationReport {
  const facts = {
    projectId: project.config.projectId,
    ...changeFacts(diff),
    ...progressFacts(result),
  };
  if (result.ok) {
    return succeededReport('push', {
      ...facts,
      lockFilePath: project.paths.lockFilePath,
      lockDigest: lockDigest(result.lock),
      lockUpdated: result.lockUpdated,
      keptUnreferencedKeys: result.plan.keptUnreferenced.map((object) => object.objectKey),
    });
  }
  // Stored but not referenced by the committed lock; they stay (nothing is ever deleted) and the
  // next successful push references them.
  const unreferenced = [...result.created, ...result.alreadyStored];
  return failedReport('push', result.error, {
    facts: {
      ...facts,
      lockUpdated: false,
      unreferencedKeys: unreferenced.map((object) => object.objectKey),
    },
  });
}

/** The scan preview, refused when it would drop IDs from the lock without --confirm-removals. */
async function previewWithRemovalGate(
  project: CheckedProject,
  invocation: Invocation,
): Promise<PreviewOutcome> {
  const outcome = await previewSources('push', project);
  if (!outcome.ok) return outcome;
  const { diff } = outcome.preview;
  if (diff.removed.length === 0 || invocation.policy.isRemovalConfirmed) return outcome;
  return { ok: false, report: unconfirmedRemovalsReport(diff) };
}

/** The locks and concurrency the transfers work with; the signal is added by the caller. */
function pushContextOf(
  project: CheckedProject,
  { committed, staged }: SourcePreview,
  invocation: Invocation,
): Omit<PushContext, 'signal'> {
  const concurrency = invocation.policy.concurrency ?? project.config.limits.concurrency;
  return { project, committed, staged, concurrency };
}

/**
 * Cancellation is observed from here on: Ctrl+C during the local preview stops the push before
 * any credential is read, during transfers it ends them as CANCELLED.
 */
async function pushProject(
  project: CheckedProject,
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  const signal = runtime.cancellationSignal();
  const outcome = await previewWithRemovalGate(project, invocation);
  if (!outcome.ok) return outcome.report;
  throwIfCancelled(signal);
  const context: PushContext = { ...pushContextOf(project, outcome.preview, invocation), signal };
  const result = await pushStagedLock({ ...context, storage: storageFor(context, runtime) });
  return pushReport(project, result, outcome.preview.diff);
}

/**
 * `push`: uploads every new original create-only, verifies all referenced objects in storage and
 * only then replaces the committed lock. `--dry-run` prints the plan instead and touches nothing.
 */
export function pushSources(
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  if (invocation.policy.isDryRun) return planPush(invocation);
  return runWithCheckedProject('push', invocation.policy.configFile, (project) =>
    pushProject(project, invocation, runtime),
  );
}
