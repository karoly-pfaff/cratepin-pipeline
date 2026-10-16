import type { Invocation } from '../arguments.ts';
import { runWithCheckedProject } from '../checked-project-run.ts';
import type { CommandRuntime } from '../command-runtime.ts';
import { pullPreviewReport, pullReport } from '../reports/pull-report.ts';
import { committedLockFor } from '../committed-lock.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { previewPull, pullLockedOriginals } from '../../pull/pull-run.ts';
import type { PullRequest } from '../../pull/pull-run.ts';
import { openReadTransport } from '../../pull/read-transport.ts';
import type { OperationReport } from '../../report.ts';

const COMMAND = 'pull';

type PullSettings = Omit<PullRequest, 'openReader' | 'signal'>;

function pullSettingsOf(
  project: CheckedProject,
  lock: SourceLock,
  invocation: Invocation,
): PullSettings {
  const { policy } = invocation;
  return {
    project,
    lock,
    isOffline: policy.isOffline,
    isRestoringSources: policy.isRestoringSources,
    concurrency: policy.concurrency ?? project.config.limits.concurrency,
  };
}

/**
 * Ctrl+C cancels the transfers cleanly. The read transport is created only on the first cache
 * miss and never offline, so a warm cache needs no credential and no network.
 */
async function pullProject(
  project: CheckedProject,
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  const loaded = await committedLockFor(COMMAND, project);
  if (!loaded.ok) return loaded.report;
  const settings = pullSettingsOf(project, loaded.lock, invocation);
  if (invocation.policy.isDryRun) return pullPreviewReport(settings, await previewPull(settings));
  const result = await pullLockedOriginals({
    ...settings,
    openReader: () => openReadTransport(project.config, runtime, settings.concurrency),
    signal: runtime.cancellationSignal(),
  });
  return pullReport(settings, result);
}

/**
 * `pull`: makes every original the committed lock pins available as a verified cache entry,
 * downloading misses by exact key through the configured read transport. `--offline` never
 * downloads, `--restore-sources` also writes missing source files, `--dry-run` only reports.
 */
export function pullSources(
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  return runWithCheckedProject(COMMAND, invocation.policy.configFile, (project) =>
    pullProject(project, invocation, runtime),
  );
}
