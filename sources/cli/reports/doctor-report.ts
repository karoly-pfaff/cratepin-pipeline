import type { DoctorCheck } from '../../doctor/doctor-check.ts';
import type { DoctorResult } from '../../doctor/doctor-run.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { failedReport, succeededReport } from '../../report.ts';
import type { OperationReport, ReportFacts, ReportRecord } from '../../report.ts';

const COMMAND = 'doctor';

/** A failed check's code and details stay in its row, so every failure is actionable. */
function checkRow({ check, status, finding, error }: DoctorCheck): ReportRecord {
  if (error === undefined) return { check, status, finding };
  const details = Object.entries(error.details).map(([name, value]) => `${name}: ${String(value)}`);
  return { check, status, code: error.code, finding, details };
}

function projectFacts(project: CheckedProject | undefined): ReportFacts {
  if (project === undefined) return {};
  return {
    projectId: project.config.projectId,
    configFilePath: project.paths.configFilePath,
    readTransport: project.config.r2.read.transport,
  };
}

/**
 * The report of `doctor`: the tool and runtime, then one row per check with its status and
 * finding, the counts the checks measured, and their issues. The first failed check, in the
 * order they run (config, lock, cache, output, read access, writer access), is the error, so
 * the exit code says what kind of problem comes first.
 */
export function doctorReport(
  result: DoctorResult,
  tool: ReportFacts,
  isOffline: boolean,
): OperationReport {
  const measured = Object.assign(
    {},
    ...result.checks.map(({ facts }) => facts ?? {}),
  ) as ReportFacts;
  const facts = {
    ...tool,
    offline: isOffline,
    ...projectFacts(result.project),
    ...measured,
    checks: result.checks.map(checkRow),
  };
  const issues = result.checks.flatMap((check) => check.issues ?? []);
  const firstFailure = result.checks.find((check) => check.error !== undefined)?.error;
  if (firstFailure === undefined) return succeededReport(COMMAND, facts, issues);
  return failedReport(COMMAND, firstFailure, { facts, issues });
}
