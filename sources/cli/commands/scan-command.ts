import type { Invocation } from '../arguments.ts';
import { runWithCheckedProject } from '../checked-project-run.ts';
import { catalogFacts, changeFacts, previewSources } from '../source-preview.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { succeededReport } from '../../report.ts';
import type { OperationReport } from '../../report.ts';

async function reportPreview(project: CheckedProject): Promise<OperationReport> {
  const outcome = await previewSources('scan', project);
  if (!outcome.ok) return outcome.report;
  const { catalog, committed, diff } = outcome.preview;
  const facts = {
    ...catalogFacts(project, catalog),
    hasCommittedLock: committed !== undefined,
    ...changeFacts(diff),
  };
  return succeededReport('scan', facts, catalog.issues);
}

/**
 * Lists, identifies and hashes the configured originals and shows how the committed lock would
 * change; reads only, writes nothing.
 */
export function scanSources({ policy }: Invocation): Promise<OperationReport> {
  return runWithCheckedProject('scan', policy.configFile, reportPreview);
}
