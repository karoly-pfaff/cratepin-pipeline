import { toPipelineError } from '../errors.ts';
import type { PipelineError } from '../errors.ts';
import type { ReportFacts, ReportIssue } from '../report.ts';

/** The parts of a project `doctor` looks at, in the order they run and decide its exit code. */
export type CheckName = 'config' | 'lock' | 'cache' | 'output' | 'read-access' | 'writer-access';

/**
 * `ok`: as a command needs it; `notice`: usable, but something needs attention (a cold cache, no
 * lock yet); `failed`: a command would stop here; `skipped`: not looked at, with the reason.
 */
type CheckStatus = 'ok' | 'notice' | 'failed' | 'skipped';

/** One finding of `doctor`, in words a developer can act on; never a value of a variable. */
export interface DoctorCheck {
  readonly check: CheckName;
  readonly status: CheckStatus;
  readonly finding: string;
  /** Counts and states the check measured, shown as report facts. */
  readonly facts?: ReportFacts;
  readonly issues?: readonly ReportIssue[];
  /** Why the check failed; its code is the exit code of the whole run if it fails first. */
  readonly error?: PipelineError;
}

export function passed(check: CheckName, finding: string, facts?: ReportFacts): DoctorCheck {
  return { check, status: 'ok', finding, ...(facts === undefined ? {} : { facts }) };
}

export function noticed(check: CheckName, finding: string, facts?: ReportFacts): DoctorCheck {
  return { check, status: 'notice', finding, ...(facts === undefined ? {} : { facts }) };
}

export function skipped(check: CheckName, reason: string): DoctorCheck {
  return { check, status: 'skipped', finding: reason };
}

/** A failed check; its finding is the error's own message, which never holds a raw detail. */
export function failed(
  check: CheckName,
  error: PipelineError,
  details: Pick<DoctorCheck, 'facts' | 'issues'> = {},
): DoctorCheck {
  return { check, status: 'failed', finding: error.message, error, ...details };
}

/** Runs a check; anything it throws becomes its failure instead of ending the run. */
export async function guarded(
  check: CheckName,
  run: () => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (error) {
    return failed(check, toPipelineError(error));
  }
}
