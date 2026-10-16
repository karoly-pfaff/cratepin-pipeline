import { compareCodeUnits } from '../catalog/ordering.ts';
import type { SourceLock } from './source-lock.ts';

/** One stored original and every logical ID that uses it. */
export interface PlannedObject {
  readonly objectKey: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly ids: readonly string[];
}

/** Which originals a push must store, which are already locked, and which stay unreferenced. */
export interface UploadPlan {
  /** Referenced only by the staged lock: to upload, or to verify if storage already has them. */
  readonly toUpload: readonly PlannedObject[];
  /** Referenced by the committed lock too: no upload, but a push confirms them in storage again. */
  readonly alreadyLocked: readonly PlannedObject[];
  /** Referenced only by the committed lock. Kept: a push never deletes stored originals. */
  readonly keptUnreferenced: readonly PlannedObject[];
}

function objectsOf(lock: SourceLock | undefined): Map<string, PlannedObject> {
  const objects = new Map<string, PlannedObject>();
  for (const { objectKey, sha256, bytes, id } of lock?.assets ?? []) {
    const ids = [...(objects.get(objectKey)?.ids ?? []), id];
    objects.set(objectKey, { objectKey, sha256, bytes, ids });
  }
  return objects;
}

function sortedByKey(objects: Iterable<PlannedObject>): PlannedObject[] {
  return [...objects].sort((left, right) => compareCodeUnits(left.objectKey, right.objectKey));
}

/** Every object the lock references, once each with all its IDs, sorted by key. */
export function lockedObjectsOf(lock: SourceLock): PlannedObject[] {
  return sortedByKey(objectsOf(lock).values());
}

/** Plans by object key from the two locks alone; storage is not listed or consulted. */
export function planUploads(committed: SourceLock | undefined, staged: SourceLock): UploadPlan {
  const committedObjects = objectsOf(committed);
  const stagedObjects = [...objectsOf(staged).values()];
  const stagedKeys = new Set(stagedObjects.map((object) => object.objectKey));
  return {
    toUpload: sortedByKey(
      stagedObjects.filter((object) => !committedObjects.has(object.objectKey)),
    ),
    alreadyLocked: sortedByKey(
      stagedObjects.filter((object) => committedObjects.has(object.objectKey)),
    ),
    keptUnreferenced: sortedByKey(
      [...committedObjects.values()].filter((object) => !stagedKeys.has(object.objectKey)),
    ),
  };
}

/** The sum of `bytes` over the objects. */
export function totalBytes(objects: readonly PlannedObject[]): number {
  return objects.reduce((total, object) => total + object.bytes, 0);
}
