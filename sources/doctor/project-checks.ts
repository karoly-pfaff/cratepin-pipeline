import { outputPublisherOf } from '../building/publication/output-publishers.ts';
import { existingCache } from '../cache/cache-root.ts';
import { PipelineError } from '../errors.ts';
import { loadCommittedLock } from '../lock/lock-file.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import type { LockIssue } from '../lock/lock-validation.ts';
import { lockedObjectsOf } from '../lock/upload-plan.ts';
import { classifyOutputRoot } from '../output/ownership/output-marker.ts';
import type { OutputRootState } from '../output/ownership/output-marker.ts';
import { outputRootError } from '../output/ownership/root-refusals.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { inspectCachedOriginals } from '../pull/locked-originals.ts';
import type { CacheInspection } from '../pull/locked-originals.ts';
import type { ReportFacts, ReportIssue } from '../report.ts';
import { failed, noticed, passed } from './doctor-check.ts';
import type { DoctorCheck } from './doctor-check.ts';

/** The lock check and, when the committed lock is valid, the lock the later checks use. */
export interface LockCheck {
  readonly check: DoctorCheck;
  readonly lock?: SourceLock;
}

function invalidLockCheck(issues: readonly LockIssue[]): LockCheck {
  const error = new PipelineError(
    'INVALID_DATA',
    'The committed lock is invalid; see the issues.',
    {
      issueCount: issues.length,
    },
  );
  return { check: failed('lock', error, { issues }) };
}

function validLockCheck(lock: SourceLock): LockCheck {
  const objectCount = lockedObjectsOf(lock).length;
  const finding = `${String(lock.assets.length)} locked originals in ${String(objectCount)} stored objects.`;
  const facts = { lockedAssetCount: lock.assets.length, objectCount };
  return { check: passed('lock', finding, facts), lock };
}

export async function checkLock(project: CheckedProject): Promise<LockCheck> {
  const load = await loadCommittedLock(project);
  if (load.status === 'invalid') return invalidLockCheck(load.issues);
  if (load.status === 'valid') return validLockCheck(load.lock);
  return { check: noticed('lock', 'There is no committed lock yet; push the originals first.') };
}

function damagedIssue({ object }: CacheInspection): ReportIssue {
  return {
    path: object.ids.join(', '),
    code: 'CACHE_CORRUPT',
    message: `The cached original (sha256 ${object.sha256}) does not match its lock; the next pull quarantines it and downloads it again.`,
  };
}

function damagedCacheCheck(damaged: readonly CacheInspection[], facts: ReportFacts): DoctorCheck {
  const message = `${String(damaged.length)} cached originals do not match the lock; see the issues.`;
  const error = new PipelineError('INTEGRITY_MISMATCH', message, { damagedCount: damaged.length });
  return failed('cache', error, { facts, issues: damaged.map(damagedIssue) });
}

/** Every entry matches the lock; a missing one keeps an offline build from running. */
function completenessCheck(missingCount: number, total: number, facts: ReportFacts): DoctorCheck {
  if (missingCount === 0) {
    return passed('cache', `All ${String(total)} locked originals are cached and verified.`, facts);
  }
  const finding = `${String(missingCount)} of ${String(total)} locked originals are not cached; an offline build fails until a pull fills the cache.`;
  return noticed('cache', finding, facts);
}

/** What hashing the cache found: entries matching the lock, missing ones and damaged ones. */
function judgedCache(inspections: readonly CacheInspection[]): DoctorCheck {
  const damaged = inspections.filter(({ state }) => state === 'corrupt');
  const missingCount = inspections.filter(({ state }) => state === 'absent').length;
  const cachedCount = inspections.length - missingCount - damaged.length;
  const facts = { cachedCount, missingCount, damagedCount: damaged.length };
  if (damaged.length > 0) return damagedCacheCheck(damaged, facts);
  return completenessCheck(missingCount, inspections.length, facts);
}

/** Hashes every locked original's cache entry: a damaged one fails, a missing one is a notice. */
export async function checkCache(
  project: CheckedProject,
  lock: SourceLock,
  concurrency: number,
): Promise<DoctorCheck> {
  const layout = await existingCache(project);
  return judgedCache(await inspectCachedOriginals(layout, lockedObjectsOf(lock), concurrency));
}

function usableOutputCheck(rootState: OutputRootState, hasLeftovers: boolean): DoctorCheck {
  const facts = { outputRootState: rootState.state };
  if (hasLeftovers) {
    return noticed(
      'output',
      'An interrupted build left work files; the next build recovers them.',
      facts,
    );
  }
  return passed('output', USABLE_ROOT_FINDINGS[rootState.state] ?? NEW_ROOT_FINDING, facts);
}

const NEW_ROOT_FINDING = 'There is no output directory yet; the first build creates it.';

/** What a usable output root means for the next build; any other usable state is a new root. */
const USABLE_ROOT_FINDINGS: Readonly<Partial<Record<OutputRootState['state'], string>>> = {
  owned: 'This project owns the output directory.',
  empty: 'The output directory is empty; the first build fills it.',
};

/** Whether a build may publish into the output root, read only, as a build would meet it. */
export async function checkOutput(project: CheckedProject): Promise<DoctorCheck> {
  const { outputRoot } = project.paths;
  const publisher = outputPublisherOf(project);
  const rootState = await classifyOutputRoot(outputRoot, project.config);
  const refusal =
    outputRootError(rootState, outputRoot) ?? (await publisher.rootRefusal(rootState));
  if (refusal !== undefined)
    return failed('output', refusal, { facts: { outputRootState: rootState.state } });
  return usableOutputCheck(rootState, await publisher.hasLeftovers());
}
