import { toPipelineError } from '../errors.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { assertLayoutStillSafe } from '../paths/layout/checked-project.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { ensureDirectory } from '../paths/files/create-only-files.ts';
import { claimCacheExclusively, isClaimLive, readAllClaims } from './cache-claims.ts';
import type { FoundClaim } from './cache-claims.ts';
import type { CacheLayout } from './cache-layout.ts';
import { assertCacheDirectoriesReal } from './cache-inventory.ts';
import { planPrune, removePlannedFiles } from './cache-prune.ts';
import type { PrunePlan, PruneRemoval } from './cache-prune.ts';
import { existingCache } from './cache-root.ts';

/** A prune of the project's cache against its committed lock. */
export interface PruneRequest {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
  /**
   * Reads the committed lock again once the cache is held, so a lock a push committed while the
   * prune waited is the one it prunes against; without it, `lock` is used.
   */
  readonly lockOnceHeld?: () => Promise<SourceLock>;
  /** Only inspect: hash the referenced entries and report what would go; change nothing. */
  readonly isDryRun: boolean;
  /** Entries hashed at the same time by an inspection. */
  readonly concurrency: number;
  readonly signal?: AbortSignal | undefined;
}

/** What a prune found and did; `plan` is absent when there is no cache, or planning failed. */
export interface PruneResult {
  readonly cacheExists: boolean;
  readonly plan?: PrunePlan;
  /** A real run: what was removed, and why it stopped early if it did. */
  readonly removal?: PruneRemoval;
  /** Claims of runs that are (or may be) still running: a real prune refuses while any exists. */
  readonly liveClaims: readonly FoundClaim[];
  /** Claim files of dead runs: removed by a real run, listed by a dry run. */
  readonly deadClaimFiles: readonly string[];
}

/** Reads the claims and the plan, hashing the referenced entries, and changes nothing. */
async function inspectCache(request: PruneRequest, layout: CacheLayout): Promise<PruneResult> {
  const claims = await readAllClaims(layout);
  const integrity = { concurrency: request.concurrency, signal: request.signal };
  return {
    cacheExists: true,
    plan: await planPrune(layout, request.lock, integrity),
    liveClaims: claims.filter((found) => isClaimLive(found.owner)),
    deadClaimFiles: claims.filter((found) => !isClaimLive(found.owner)).map(({ file }) => file),
  };
}

/** Plans and removes; a failure keeps the dead claims already removed in the result. */
async function planAndRemove(
  request: PruneRequest,
  layout: CacheLayout,
  deadClaimFiles: readonly string[],
): Promise<PruneResult> {
  const without = { cacheExists: true, liveClaims: [], deadClaimFiles };
  try {
    const lock = request.lockOnceHeld === undefined ? request.lock : await request.lockOnceHeld();
    const plan = await planPrune(layout, lock);
    return { ...without, plan, removal: await removePlannedFiles(plan, request.signal) };
  } catch (error) {
    return { ...without, removal: { removed: [], error: toPipelineError(error) } };
  }
}

function ignoreLeftoverClaim(): void {
  // The next exclusive claim removes it.
}

/**
 * Checks the layout again, then holds the cache exclusively while it plans and removes, so no
 * pull can use what goes. It does not hash: corrupt entries are an inspection's business, and
 * the claim keeps pulls out for as short a time as possible.
 */
async function pruneExclusively(request: PruneRequest, layout: CacheLayout): Promise<PruneResult> {
  await assertLayoutStillSafe(request.project, 'nothing was removed');
  await assertCacheDirectoriesReal(layout);
  await ensureDirectory(layout.claims);
  const { claim, removedDeadClaimFiles } = await claimCacheExclusively(layout, 'cache prune');
  try {
    return await planAndRemove(request, layout, removedDeadClaimFiles);
  } finally {
    // A claim left behind is dead once this process ends; it must not replace what was removed.
    await claim.release().catch(ignoreLeftoverClaim);
  }
}

/**
 * Removes from the local cache what the committed lock does not need: unreferenced entries,
 * leftover part files, quarantined entries, temporary files and claims of dead runs. Entries the
 * lock references stay; names the layout does not explain stay; a cache directory that is a link
 * stops it before anything is removed. It never touches storage or the source directory, and a
 * cache that does not exist is not created.
 */
export async function pruneCache(request: PruneRequest): Promise<PruneResult> {
  const layout = await existingCache(request.project);
  if (layout === undefined) return { cacheExists: false, liveClaims: [], deadClaimFiles: [] };
  return request.isDryRun ? inspectCache(request, layout) : pruneExclusively(request, layout);
}
