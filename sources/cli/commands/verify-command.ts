import type { Invocation } from '../arguments.ts';
import { runWithCheckedProject } from '../checked-project-run.ts';
import { committedLockFor } from '../committed-lock.ts';
import { verifyReport } from '../reports/verify-report.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import type { OperationReport } from '../../report.ts';
import { verifyOutput } from '../../verify/output-verification.ts';

const COMMAND = 'verify';

async function verifyProject(project: CheckedProject): Promise<OperationReport> {
  const loaded = await committedLockFor(COMMAND, project);
  if (!loaded.ok) return loaded.report;
  return verifyReport(project, await verifyOutput({ project, lock: loaded.lock }));
}

/**
 * `verify`: audits the published output against the committed lock and config before packaging.
 * It reads only: no claim, no cache, no credential and no network access.
 */
export function verifyPublishedOutput(invocation: Invocation): Promise<OperationReport> {
  return runWithCheckedProject(COMMAND, invocation.policy.configFile, verifyProject);
}
