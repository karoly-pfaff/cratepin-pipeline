import { invalidLockError } from './source-preview.ts';
import { PipelineError } from '../errors.ts';
import { loadCommittedLock } from '../lock/lock-file.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { failedReport } from '../report.ts';
import type { OperationReport } from '../report.ts';

export type LockOutcome =
  | { readonly ok: true; readonly lock: SourceLock }
  | { readonly ok: false; readonly report: OperationReport };

/** The committed lock pins what a command works with; without a valid one it cannot run. */
export async function committedLockFor(
  command: string,
  project: CheckedProject,
): Promise<LockOutcome> {
  const load = await loadCommittedLock(project);
  if (load.status === 'valid') return { ok: true, lock: load.lock };
  if (load.status === 'invalid') {
    const report = failedReport(command, invalidLockError(load.issues), { issues: load.issues });
    return { ok: false, report };
  }
  const absent = new PipelineError(
    'NOT_FOUND',
    'There is no committed lock file; check lockFile, or push the originals first.',
    { lockFilePath: project.paths.lockFilePath },
  );
  return { ok: false, report: failedReport(command, absent) };
}
