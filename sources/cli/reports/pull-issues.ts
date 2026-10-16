import type { ErrorCode, PipelineError } from '../../errors.ts';
import type { SourceRecord, SourceLock } from '../../lock/source-lock.ts';
import type { PlannedObject } from '../../lock/upload-plan.ts';
import type { ReportIssue } from '../../report.ts';

/** Why a locked original could not be retrieved, as the per-ID issue code. */
const ISSUE_CODES_BY_ERROR_CODE: ReadonlyMap<ErrorCode, string> = new Map([
  ['NOT_FOUND', 'OBJECT_MISSING'],
  ['AUTH_FAILED', 'OBJECT_FORBIDDEN'],
  ['INTEGRITY_MISMATCH', 'OBJECT_CORRUPT'],
]);

/** A lock record together with what happened to its object. */
export interface RecordOutcome<Outcome> {
  readonly record: SourceRecord;
  readonly outcome: Outcome;
}

/** Every record of the lock, in lock order, with the outcome of the object it uses. */
export function recordOutcomes<Outcome extends { readonly object: PlannedObject }>(
  lock: SourceLock,
  outcomes: readonly Outcome[],
): RecordOutcome<Outcome>[] {
  const byKey = new Map(outcomes.map((outcome) => [outcome.object.objectKey, outcome]));
  return lock.assets.flatMap((record) => {
    const outcome = byKey.get(record.objectKey);
    return outcome === undefined ? [] : [{ record, outcome }];
  });
}

function described(record: SourceRecord): string {
  return `"${record.id}" (sha256 ${record.sha256})`;
}

export function failureIssue(record: SourceRecord, error: PipelineError): ReportIssue {
  return {
    path: record.source,
    code: ISSUE_CODES_BY_ERROR_CODE.get(error.code) ?? 'DOWNLOAD_FAILED',
    message: `${described(record)} could not be retrieved: ${error.message}`,
  };
}

export function cacheMissIssue(record: SourceRecord): ReportIssue {
  return {
    path: record.source,
    code: 'CACHE_MISS',
    message: `${described(record)} is not in the cache, and offline mode downloads nothing.`,
  };
}

export function corruptEntryNotice(record: SourceRecord, consequence: string): ReportIssue {
  return {
    path: record.source,
    code: 'CACHE_CORRUPT',
    message: `The cache entry of ${described(record)} was corrupt; it ${consequence}.`,
  };
}

export function keptSourceNotice(source: string): ReportIssue {
  return {
    path: source,
    code: 'SOURCE_KEPT',
    message: 'The source file differs from the lock and was left unchanged.',
  };
}

export function restoreSkippedNotice(): ReportIssue {
  return {
    path: '.',
    code: 'RESTORE_SKIPPED',
    message: 'No source was restored, because not every locked original is in the cache.',
  };
}
