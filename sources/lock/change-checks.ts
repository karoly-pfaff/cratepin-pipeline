import { sourceIssue } from '../catalog/source-issues.ts';
import type { SourceIssue } from '../catalog/source-issues.ts';
import type { LockDiff } from './lock-diff.ts';
import type { SourceLock } from './source-lock.ts';

/**
 * An empty source tree next to a non-empty committed lock is a missing restore (a fresh checkout),
 * not a deliberate wipe; a lock written from it would drop every ID. Partly missing sources are
 * not detected: they look exactly like deliberate removals.
 */
export function sourcesMissingIssues(
  committed: SourceLock | undefined,
  catalogedAssetCount: number,
): SourceIssue[] {
  const lockedCount = committed?.assets.length ?? 0;
  if (lockedCount === 0 || catalogedAssetCount > 0) return [];
  const detail = `The committed lock lists ${String(lockedCount)} originals.`;
  return [sourceIssue('.', 'SOURCES_MISSING', detail)];
}

/** A notice at the new source for every ID whose bytes the committed lock knew under another ID. */
export function identityChangeNotices(diff: LockDiff): SourceIssue[] {
  return diff.identityChanges.map(({ from, to }) =>
    sourceIssue(to.source, 'IDENTITY_CHANGED', `Previous ID: ${from.id}.`),
  );
}
