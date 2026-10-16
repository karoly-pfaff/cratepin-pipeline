import type { Invocation } from '../arguments.ts';
import { runWithCheckedProject } from '../checked-project-run.ts';
import { changeFacts, previewSources } from '../source-preview.ts';
import { lockDigest } from '../../lock/source-lock.ts';
import { planUploads, totalBytes } from '../../lock/upload-plan.ts';
import type { PlannedObject, UploadPlan } from '../../lock/upload-plan.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { succeededReport } from '../../report.ts';
import type { OperationReport, ReportFacts, ReportRecord } from '../../report.ts';

/** Reports say what ran: a plan, not a push. */
const DRY_RUN_LABEL = 'push --dry-run';

function objectRows(objects: readonly PlannedObject[]): ReportRecord[] {
  return objects.map(({ objectKey, bytes, sha256, ids }) => ({
    objectKey,
    bytes,
    sha256,
    ids,
  }));
}

function planFacts(plan: UploadPlan): ReportFacts {
  return {
    uploadCount: plan.toUpload.length,
    uploadBytes: totalBytes(plan.toUpload),
    uploads: objectRows(plan.toUpload),
    alreadyLockedCount: plan.alreadyLocked.length,
    keptUnreferencedCount: plan.keptUnreferenced.length,
    keptUnreferencedBytes: totalBytes(plan.keptUnreferenced),
    keptUnreferenced: objectRows(plan.keptUnreferenced),
  };
}

async function reportUploadPlan(project: CheckedProject): Promise<OperationReport> {
  const outcome = await previewSources(DRY_RUN_LABEL, project);
  if (!outcome.ok) return outcome.report;
  const { catalog, committed, staged, diff } = outcome.preview;
  const facts = {
    projectId: project.config.projectId,
    dryRun: true,
    hasCommittedLock: committed !== undefined,
    stagedLockDigest: lockDigest(staged),
    ...changeFacts(diff),
    ...planFacts(planUploads(committed, staged)),
  };
  return succeededReport(DRY_RUN_LABEL, facts, catalog.issues);
}

/**
 * `push --dry-run`: what a push would upload and how the lock would change, from the local
 * sources and the committed lock alone. Writes nothing, contacts no storage, reads no credential.
 */
export function planPush({ policy }: Invocation): Promise<OperationReport> {
  return runWithCheckedProject(DRY_RUN_LABEL, policy.configFile, reportUploadPlan);
}
