#!/usr/bin/env node
import { isHelpRequest, parseInvocation } from './arguments.ts';
import { helpText } from './command-specs.ts';
import type { OutputFormat } from './arguments.ts';
import { processRuntime } from './command-runtime.ts';
import type { CommandRuntime } from './command-runtime.ts';
import { runInvocation } from './commands.ts';
import { toPipelineError } from '../errors.ts';
import type { RedactionContext } from '../redaction.ts';
import { exitCodeOf, failedReport, renderReportAsJson, renderReportAsText } from '../report.ts';
import type { OperationReport } from '../report.ts';

const EXIT_SUCCESS = 0;

/** Chosen before parsing so even a usage error is rendered in the format the user asked for. */
function requestedOutputFormat(argv: readonly string[]): OutputFormat {
  const endOfOptions = argv.indexOf('--');
  const options = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions);
  return options.includes('--json') ? 'json' : 'text';
}

/** Rendered with the secrets this run resolved, so none of them can appear in the output. */
function printReport(
  report: OperationReport,
  outputFormat: OutputFormat,
  redaction: RedactionContext,
): void {
  const rendered =
    outputFormat === 'json'
      ? renderReportAsJson(report, redaction)
      : renderReportAsText(report, redaction);
  if (report.status === 'succeeded') console.log(rendered);
  else console.error(rendered);
}

async function reportForCommandLine(
  argv: readonly string[],
  runtime: CommandRuntime,
): Promise<OperationReport> {
  try {
    return await runInvocation(parseInvocation(argv), runtime);
  } catch (error) {
    return failedReport(argv[0] ?? 'cratepin', toPipelineError(error));
  }
}

async function runCommandLine(argv: readonly string[]): Promise<number> {
  if (isHelpRequest(argv)) {
    console.log(helpText());
    return EXIT_SUCCESS;
  }
  const runtime = processRuntime();
  const report = await reportForCommandLine(argv, runtime);
  printReport(report, requestedOutputFormat(argv), runtime.secrets.redactionContext);
  return exitCodeOf(report);
}

process.exitCode = await runCommandLine(process.argv.slice(2));
