import { sortedByPath } from '../../catalog/ordering.ts';
import { PipelineError } from '../../errors.ts';
import type { ErrorCode } from '../../errors.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { failedReport, succeededReport } from '../../report.ts';
import type { OperationReport, ReportIssue } from '../../report.ts';
import type { Verification } from '../../verify/output-verification.ts';

const COMMAND = 'verify';

/** Issues of something in the output that the tool did not publish but that would ship. */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'INTERRUPTED_PUBLICATION',
  'UNKNOWN_OUTPUT_NAME',
  'UNLISTED_OUTPUT_ENTRY',
]);
/** Issues of bytes that are not what the listing or their name says. */
const BYTE_CODES: ReadonlySet<string> = new Set(['OUTPUT_MISSING', 'OUTPUT_MISMATCH']);

/**
 * The failure of a verification with issues: an output conflict (exit 9) when something would
 * ship that the tool did not publish, else a byte mismatch (INTEGRITY_MISMATCH, exit 7), else
 * invalid data (exit 8) for a manifest that is damaged, stale or unsafe.
 */
function errorCodeOf(issues: readonly ReportIssue[]): ErrorCode {
  const codes = issues.map(({ code }) => code);
  if (codes.some((code) => CONFLICT_CODES.has(code))) return 'OUTPUT_CONFLICT';
  return codes.some((code) => BYTE_CODES.has(code)) ? 'INTEGRITY_MISMATCH' : 'INVALID_DATA';
}

function verificationError(issues: readonly ReportIssue[]): PipelineError {
  const code = errorCodeOf(issues);
  return new PipelineError(
    code,
    `The published output is not ready for packaging (${String(issues.length)} issues); see the issues.`,
    { issueCount: issues.length },
  );
}

/**
 * The report of `verify`: what was checked (the manifest, the generation, the assets and the
 * files with their bytes) and every problem, sorted by path; any problem fails it.
 */
export function verifyReport(project: CheckedProject, verification: Verification): OperationReport {
  const facts = {
    projectId: project.config.projectId,
    outputRoot: project.paths.outputRoot,
    outputMode: project.config.outputMode,
    manifestFile: verification.manifestFile,
    ...(verification.generation === undefined ? {} : { generation: verification.generation }),
    assetCount: verification.assetCount,
    fileCount: verification.fileCount,
    byteCount: verification.byteCount,
  };
  const issues = sortedByPath(verification.issues);
  return issues.length === 0
    ? succeededReport(COMMAND, facts)
    : failedReport(COMMAND, verificationError(issues), { facts, issues });
}
