import type { BlobReader } from '../blob-store.ts';
import { claimCacheUse } from '../cache/cache-claims.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { existingCache, prepareCache } from '../cache/cache-root.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { lockedObjectsOf } from '../lock/upload-plan.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { inspectCachedOriginals, retrieveLockedOriginals } from './locked-originals.ts';
import type { CacheInspection, OriginalOutcome } from './locked-originals.ts';
import { planAndRestoreSources, planSourceRestore } from './source-restore.ts';
import type { SourceRestorePlan, SourceRestoreResult } from './source-restore.ts';

/** Everything a pull needs: the preflighted project, its committed lock and how to read storage. */
export interface PullRequest {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
  /** Never download; no read transport is created. */
  readonly isOffline: boolean;
  /** Afterwards, write locked sources missing from the source directory. */
  readonly isRestoringSources: boolean;
  /** Objects checked or downloaded at the same time. */
  readonly concurrency: number;
  /** Creates the read transport; called only on the first cache miss, never offline. */
  readonly openReader: () => BlobReader;
  readonly signal?: AbortSignal | undefined;
}

export interface PullResult {
  readonly originals: readonly OriginalOutcome[];
  /** Present when sources were to be restored and every original is in the cache. */
  readonly restore?: SourceRestoreResult;
}

/** What a pull would do; nothing was written, downloaded or resolved. */
export interface PullPreview {
  readonly inspections: readonly CacheInspection[];
  readonly restorePlan?: SourceRestorePlan;
}

function ignoreLeftoverClaim(): void {
  // Pulls ignore dead claims, and the next exclusive claim removes it.
}

function isInCache(outcome: OriginalOutcome): boolean {
  return outcome.status === 'cached' || outcome.status === 'downloaded';
}

/**
 * Makes every original the committed lock pins available as a verified cache entry, then, when
 * asked and only if all of them are there, restores missing source files from the cache without
 * replacing any existing one. Exact locked keys only: storage is never listed.
 */
export async function pullLockedOriginals(request: PullRequest): Promise<PullResult> {
  const layout = await prepareCache(request.project);
  const claim = await claimCacheUse(layout, 'pull');
  try {
    return await pullWithClaim(request, layout);
  } finally {
    // A claim left behind is dead once this process ends; it must not replace the pull's outcome.
    await claim.release().catch(ignoreLeftoverClaim);
  }
}

/** The pull itself, while its claim keeps a prune from removing anything it uses. */
async function pullWithClaim(request: PullRequest, layout: CacheLayout): Promise<PullResult> {
  const { project, lock, signal } = request;
  const originals = await retrieveLockedOriginals({
    layout,
    objects: lockedObjectsOf(lock),
    isOffline: request.isOffline,
    openReader: request.openReader,
    concurrency: request.concurrency,
    signal,
  });
  if (!request.isRestoringSources || !originals.every(isInCache)) return { originals };
  return { originals, restore: await planAndRestoreSources({ project, layout, lock, signal }) };
}

/** Checks the cache and, when asked, the source directory as a pull would, and changes nothing. */
export async function previewPull(
  request: Omit<PullRequest, 'openReader' | 'signal'>,
): Promise<PullPreview> {
  const { project, lock } = request;
  const layout = await existingCache(project);
  const objects = lockedObjectsOf(lock);
  const inspections = await inspectCachedOriginals(layout, objects, request.concurrency);
  // Offline, a missing original means the real run skips the restore, and so its planning.
  const isAnyMissingOffline =
    request.isOffline && inspections.some((inspection) => inspection.state !== 'verified');
  if (!request.isRestoringSources || isAnyMissingOffline) return { inspections };
  return { inspections, restorePlan: await planSourceRestore(project, lock) };
}
