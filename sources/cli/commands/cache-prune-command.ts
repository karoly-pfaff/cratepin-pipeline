import type { Invocation } from '../arguments.ts';
import { cachePruneReport } from '../reports/cache-prune-report.ts';
import { runWithCheckedProject } from '../checked-project-run.ts';
import type { CommandRuntime } from '../command-runtime.ts';
import { committedLockFor } from '../committed-lock.ts';
import { pruneCache } from '../../cache/cache-prune-run.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { PipelineError, toPipelineError } from '../../errors.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import { failedReport } from '../../report.ts';
import type { OperationReport } from '../../report.ts';

const COMMAND = 'cache prune';

/** The committed lock as it is now; a lock that became invalid meanwhile stops the prune. */
async function committedLockOf(project: CheckedProject): Promise<SourceLock> {
  const loaded = await committedLockFor(COMMAND, project);
  if (loaded.ok) return loaded.lock;
  throw new PipelineError(
    'INVALID_DATA',
    'The committed lock changed while the prune waited and can no longer be read; nothing was removed.',
    {
      lockFilePath: project.paths.lockFilePath,
    },
  );
}

/**
 * Ctrl+C stops a real prune before its next file; a dry run changes nothing and keeps the
 * default (Ctrl+C ends it at once).
 */
async function pruneProject(
  project: CheckedProject,
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  const loaded = await committedLockFor(COMMAND, project);
  if (!loaded.ok) return loaded.report;
  const { isDryRun } = invocation.policy;
  try {
    const result = await pruneCache({
      project,
      lock: loaded.lock,
      lockOnceHeld: () => committedLockOf(project),
      isDryRun,
      concurrency: project.config.limits.concurrency,
      signal: isDryRun ? undefined : runtime.cancellationSignal(),
    });
    return cachePruneReport(project, result, isDryRun);
  } catch (error) {
    return refusedReport(project, toPipelineError(error), isDryRun);
  }
}

/**
 * A prune that stopped before removing anything: another run's claim, a linked cache directory,
 * an unsafe layout, or (dry run) a failure while inspecting.
 */
function refusedReport(
  project: CheckedProject,
  error: PipelineError,
  isDryRun: boolean,
): OperationReport {
  const facts = { projectId: project.config.projectId, cacheRoot: project.paths.cacheRoot };
  const removal = isDryRun ? {} : { removed: [], removedBytes: 0 };
  return failedReport(COMMAND, error, { facts: { ...facts, ...removal } });
}

/**
 * `cache prune`: removes from the local cache what the committed lock does not reference, and the
 * leftovers of crashed runs, while holding the cache exclusively; `--dry-run` reports the same
 * without a claim and changes nothing. Storage and the source directory are never touched.
 */
export function runCachePrune(
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  return runWithCheckedProject(COMMAND, invocation.policy.configFile, (project) =>
    pruneProject(project, invocation, runtime),
  );
}
