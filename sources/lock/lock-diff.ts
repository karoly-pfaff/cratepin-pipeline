import { SOURCE_RECORD_FIELDS } from './source-lock.ts';
import type { SourceLock, SourceRecord, SourceRecordField } from './source-lock.ts';

/** A logical ID present in both locks whose record differs, with the fields that differ. */
export interface ChangedRecord {
  readonly before: SourceRecord;
  readonly after: SourceRecord;
  readonly changedFields: readonly SourceRecordField[];
}

/** An ID that disappeared while another appeared with the same bytes: usually a rename. */
export interface IdentityChange {
  readonly from: SourceRecord;
  readonly to: SourceRecord;
}

/** What a staged lock changes compared with the committed one, ID by ID. */
export interface LockDiff {
  readonly added: readonly SourceRecord[];
  readonly changed: readonly ChangedRecord[];
  readonly unchanged: readonly SourceRecord[];
  /** No longer referenced by the new lock; this never deletes anything from storage. */
  readonly removed: readonly SourceRecord[];
  readonly identityChanges: readonly IdentityChange[];
}

function changedFieldsOf(before: SourceRecord, after: SourceRecord): SourceRecordField[] {
  return SOURCE_RECORD_FIELDS.filter((field) => before[field] !== after[field]);
}

function identityChangesOf(
  removed: readonly SourceRecord[],
  added: readonly SourceRecord[],
): IdentityChange[] {
  const addedBySha256 = Map.groupBy(added, (record) => record.sha256);
  return removed.flatMap((gone) =>
    (addedBySha256.get(gone.sha256) ?? []).map((appeared) => ({ from: gone, to: appeared })),
  );
}

/** Sorts each staged record into added, changed or unchanged by its ID's committed record. */
function classifyStagedRecords(
  committedById: ReadonlyMap<string, SourceRecord>,
  staged: SourceLock,
): Pick<LockDiff, 'added' | 'changed' | 'unchanged'> {
  const added: SourceRecord[] = [];
  const changed: ChangedRecord[] = [];
  const unchanged: SourceRecord[] = [];
  for (const after of staged.assets) {
    const before = committedById.get(after.id);
    const changedFields = before === undefined ? [] : changedFieldsOf(before, after);
    if (before === undefined) added.push(after);
    else if (changedFields.length > 0) changed.push({ before, after, changedFields });
    else unchanged.push(after);
  }
  return { added, changed, unchanged };
}

/**
 * Compares a staged lock with the committed one (none yet: everything is added). Only the two
 * locks are compared: storage is never listed, so "latest remote content" decides nothing.
 */
export function diffLocks(committed: SourceLock | undefined, staged: SourceLock): LockDiff {
  const committedAssets = committed?.assets ?? [];
  const committedById = new Map(committedAssets.map((record) => [record.id, record]));
  const stagedIds = new Set(staged.assets.map((record) => record.id));
  const removed = committedAssets.filter((record) => !stagedIds.has(record.id));
  const changes = classifyStagedRecords(committedById, staged);
  return { ...changes, removed, identityChanges: identityChangesOf(removed, changes.added) };
}
