import type { Invocation } from '../arguments.ts';
import type { CommandRuntime } from '../command-runtime.ts';
import { doctorReport } from '../reports/doctor-report.ts';
import { runDoctor } from '../../doctor/doctor-run.ts';
import { toolFacts } from '../../doctor/tool-facts.ts';
import type { OperationReport } from '../../report.ts';

/**
 * `doctor`: what the tool, the project and, unless `--offline`, its storage access look like,
 * read only. Offline it resolves no credential and sends no request.
 */
export async function diagnoseProject(
  { policy }: Invocation,
  runtime: CommandRuntime,
): Promise<OperationReport> {
  const result = await runDoctor({
    configFile: policy.configFile,
    isOffline: policy.isOffline,
    environment: runtime,
  });
  return doctorReport(result, await toolFacts(), policy.isOffline);
}
