import type { ConfigIssue } from '../config/pipeline-config.ts';
import { PipelineError } from '../errors.ts';
import { loadCheckedProject } from '../paths/layout/checked-project.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { failedReport } from '../report.ts';
import type { OperationReport } from '../report.ts';

function invalidConfigReport(command: string, issues: readonly ConfigIssue[]): OperationReport {
  const invalid = new PipelineError('CONFIG_INVALID', 'Configuration is invalid.', {
    issueCount: issues.length,
  });
  return failedReport(command, invalid, { issues });
}

/**
 * Loads and preflights the project, then runs `useProject` on it; an invalid config or an unsafe
 * layout becomes a CONFIG_INVALID report listing every issue, and `useProject` never runs.
 */
export async function runWithCheckedProject(
  command: string,
  configFile: string,
  useProject: (project: CheckedProject) => Promise<OperationReport>,
): Promise<OperationReport> {
  const load = await loadCheckedProject(configFile);
  if (!load.ok) return invalidConfigReport(command, load.issues);
  return useProject(load.project);
}
