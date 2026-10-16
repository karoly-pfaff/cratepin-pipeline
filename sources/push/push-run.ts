import { join } from 'node:path';

import { throwIfCancelled, toPipelineError } from '../errors.ts';
import type { PipelineError } from '../errors.ts';
import { FinalizedLock } from '../lock/lock-finalization.ts';
import type { VerifiedObject } from '../lock/lock-finalization.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { planUploads } from '../lock/upload-plan.ts';
import type { PlannedObject, UploadPlan } from '../lock/upload-plan.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { BoundedTasks } from '../storage/transfer/bounded-tasks.ts';
import { assertLockWritable, writeFinalizedLock } from './lock-writer.ts';
import { verifyByReadback } from './object-verification.ts';
import { createFromSource } from './source-upload.ts';
import type { ObjectSource, PushStorage } from './source-upload.ts';

/** Everything a push needs: the preflighted project, both locks and storage access. */
export interface PushRequest {
  readonly project: CheckedProject;
  readonly committed: SourceLock | undefined;
  readonly staged: SourceLock;
  readonly storage: PushStorage;
  /** Objects transferred at the same time. */
  readonly concurrency: number;
  readonly signal?: AbortSignal | undefined;
}

/** What storage holds now, object by object, whether or not the lock could be written. */
export interface StorageProgress {
  readonly created: readonly PlannedObject[];
  readonly alreadyStored: readonly PlannedObject[];
  readonly confirmed: readonly PlannedObject[];
}

export type PushResult =
  | ({
      readonly ok: true;
      readonly plan: UploadPlan;
      readonly lock: SourceLock;
      /** False when the committed lock already had exactly this content. */
      readonly lockUpdated: boolean;
    } & StorageProgress)
  | ({
      readonly ok: false;
      readonly plan: UploadPlan;
      readonly error: PipelineError;
    } & StorageProgress);

interface MutableProgress {
  readonly created: PlannedObject[];
  readonly alreadyStored: PlannedObject[];
  readonly confirmed: PlannedObject[];
  readonly verified: VerifiedObject[];
}

/** The local file holding each object's bytes: the source of the first staged record using it. */
function sourcePathsByKey(request: PushRequest): Map<string, string> {
  const { sourceRoot } = request.project.paths;
  const paths = new Map<string, string>();
  for (const { objectKey, source } of request.staged.assets) {
    if (!paths.has(objectKey)) paths.set(objectKey, join(sourceRoot, ...source.split('/')));
  }
  return paths;
}

/** Every planned object comes from a staged record, so its source is always known. */
function sourcePathOf(sourcePaths: ReadonlyMap<string, string>, object: PlannedObject): string {
  const sourcePath = sourcePaths.get(object.objectKey);
  if (sourcePath !== undefined) return sourcePath;
  throw new Error('Every planned object has a staged source.');
}

/**
 * Creates the object, records what happened before proving it, so an object this push created
 * is reported even when its readback then fails, and verifies it by readback.
 */
async function uploadOne(
  request: PushRequest,
  source: ObjectSource,
  progress: MutableProgress,
): Promise<void> {
  const options = { signal: request.signal };
  const outcome = await createFromSource(request.storage.writer, source, options);
  (outcome === 'created' ? progress.created : progress.alreadyStored).push(source.object);
  progress.verified.push(await verifyByReadback(request.storage.reader, source.object, options));
}

async function confirmOne(
  request: PushRequest,
  object: PlannedObject,
  progress: MutableProgress,
): Promise<void> {
  const options = { signal: request.signal };
  progress.verified.push(await verifyByReadback(request.storage.reader, object, options));
  progress.confirmed.push(object);
}

/** One task per object: upload and verify the new ones, verify the already locked ones. */
function transferTasks(
  request: PushRequest,
  plan: UploadPlan,
  progress: MutableProgress,
): (() => Promise<void>)[] {
  const sourcePaths = sourcePathsByKey(request);
  const uploads = plan.toUpload.map((object) => {
    const source = { object, sourcePath: sourcePathOf(sourcePaths, object) };
    return () => uploadOne(request, source, progress);
  });
  const confirmations = plan.alreadyLocked.map(
    (object) => () => confirmOne(request, object, progress),
  );
  return [...uploads, ...confirmations];
}

/**
 * Runs every transfer task, `concurrency` at a time. After the first failure no further task
 * starts; running ones finish first.
 */
async function verifyEveryObject(
  request: PushRequest,
  plan: UploadPlan,
  progress: MutableProgress,
): Promise<void> {
  await new BoundedTasks(request.concurrency).runAll(transferTasks(request, plan, progress));
}

/**
 * Checks that the lock can be written at all, transfers and verifies every object, then writes
 * the lock finalized from the measured evidence.
 */
async function transferAndFinalize(
  request: PushRequest,
  plan: UploadPlan,
  progress: MutableProgress,
): Promise<{ readonly lock: SourceLock; readonly lockUpdated: boolean }> {
  await assertLockWritable(request.project);
  await verifyEveryObject(request, plan, progress);
  // The lock rename is the commit point: a cancellation up to here leaves the previous lock.
  throwIfCancelled(request.signal);
  const finalized = FinalizedLock.fromVerifiedObjects(request.staged, progress.verified);
  const lockUpdated = await writeFinalizedLock(request.project, finalized, request.committed);
  return { lock: finalized.lock, lockUpdated };
}

/**
 * Pushes a staged lock: every referenced original is uploaded or confirmed in storage, then the
 * finalized lock replaces the committed one in a single rename. Nothing is ever deleted: after a
 * failure the previous lock is untouched and the result lists the objects created so far, which
 * stay stored unreferenced until a later push references them.
 */
export async function pushStagedLock(request: PushRequest): Promise<PushResult> {
  const plan = planUploads(request.committed, request.staged);
  const progress: MutableProgress = { created: [], alreadyStored: [], confirmed: [], verified: [] };
  try {
    const { lock, lockUpdated } = await transferAndFinalize(request, plan, progress);
    return { ok: true, plan, ...progress, lock, lockUpdated };
  } catch (error) {
    return { ok: false, plan, ...progress, error: toPipelineError(error) };
  }
}
