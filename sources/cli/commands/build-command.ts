import type { Invocation } from '../arguments.ts';
import type { BuildInputs } from '../reports/build-issues.ts';
import { buildPreviewReport, planProblemsReport } from '../reports/build-report.ts';
import { buildRunReport } from '../reports/build-run-report.ts';
import type { CommandRuntime } from '../command-runtime.ts';
import { runWithCheckedProject } from '../checked-project-run.ts';
import { committedLockFor } from '../committed-lock.ts';
import { planBuild } from '../../building/planning/build-plan.ts';
import { previewBuild } from '../../building/planning/build-preview.ts';
import { runBuild } from '../../building/build-run.ts';
import { openReadTransport } from '../../pull/read-transport.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import type { OperationReport } from '../../report.ts';

const COMMAND = 'build';

/**
 * The dry run of a committed lock: the plan first, and on its problems (clashing paths,
 * undefined profiles) the report stops there, before any I/O, as a build does; otherwise the
 * preview of the clean plan.
 */
export async function dryRunReportOf(
  settings: BuildInputs,
  concurrency: number,
): Promise<OperationReport> {
  const { project, lock } = settings;
  const plan = planBuild(project.config, lock);
  if (plan.issues.length > 0) return planProblemsReport(settings, plan, { isDryRun: true });
  return buildPreviewReport(settings, await previewBuild({ project, lock, plan, concurrency }));
}

function previewLockedBuild(
  project: CheckedProject,
  lock: SourceLock,
  { policy }: Invocation,
): Promise<OperationReport> {
  const concurrency = policy.concurrency ?? project.config.limits.concurrency;
  return dryRunReportOf({ project, lock, isOffline: policy.isOffline }, concurrency);
}

async function previewProjectBuild(
  project: CheckedProject,
  invocation: Invocation,
): Promise<OperationReport> {
  const loaded = await committedLockFor(COMMAND, project);
  return loaded.ok ? previewLockedBuild(project, loaded.lock, invocation) : loaded.report;
}

/**
 * `build --dry-run`: reports what a build would read, convert and publish from the committed
 * lock and the verified cache, and what would change in the output. It writes nothing, takes no
 * claim, resolves no credential and contacts no storage.
 */
export function previewBuildOutput(invocation: Invocation): Promise<OperationReport> {
  return runWithCheckedProject(COMMAND, invocation.policy.configFile, (project) =>
    previewProjectBuild(project, invocation),
  );
}

/** One build: the preflighted project, its committed lock, the invocation and its runtime. */
interface LockedBuild {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
  readonly invocation: Invocation;
  readonly runtime: CommandRuntime;
}

async function buildLocked({
  project,
  lock,
  invocation,
  runtime,
}: LockedBuild): Promise<OperationReport> {
  const { policy } = invocation;
  const concurrency = policy.concurrency ?? project.config.limits.concurrency;
  const result = await runBuild({
    project,
    lock,
    isOffline: policy.isOffline,
    concurrency,
    openReader: () => openReadTransport(project.config, runtime, concurrency),
    signal: runtime.cancellationSignal(),
  });
  return buildRunReport({ project, lock, isOffline: policy.isOffline }, result);
}

/**
 * `build`: builds the committed lock into the owned output root and publishes it by swapping
 * the complete, audited tree in (path-preserving mode). Originals come from the verified cache,
 * downloaded on a miss unless `--offline`; Ctrl+C stops it cleanly until the swap begins.
 */
export function buildOutput(
  invocation: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  return runWithCheckedProject(COMMAND, invocation.policy.configFile, async (project) => {
    const loaded = await committedLockFor(COMMAND, project);
    if (!loaded.ok) return loaded.report;
    return buildLocked({ project, lock: loaded.lock, invocation, runtime });
  });
}
