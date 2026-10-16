import { rm } from 'node:fs/promises';
import { basename } from 'node:path';

import { throwIfCancelled, toPipelineError } from '../errors.ts';
import type { PipelineError } from '../errors.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { lockedObjectsOf } from '../lock/upload-plan.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';
import { mapBounded } from '../storage/transfer/bounded-tasks.ts';
import { checkCachedOriginal } from './cached-originals.ts';
import { sourceSha256OfDerivativeName } from './cache-file-names.ts';
import { inventoryCache, sha256OfEntry } from './cache-inventory.ts';
import type { CacheFile } from './cache-inventory.ts';
import type { CacheLayout } from './cache-layout.ts';

/**
 * What a prune keeps and removes. Entries the lock references are kept, and so are the
 * derivatives made from them, whatever profile or encoder made them. Everything else the layout
 * names is removable: unreferenced entries and their derivatives, part files, quarantined files
 * and temporary files. Unknown names are kept and reported.
 */
export interface PrunePlan {
  readonly referenced: readonly CacheFile[];
  /** Outputs and records of derivatives made from a referenced original. */
  readonly referencedDerivatives: readonly CacheFile[];
  /**
   * Referenced entries that do not hold the locked bytes, when the plan hashed them (an
   * inspection does; the next pull quarantines and fetches them again).
   */
  readonly corruptReferenced?: readonly CacheFile[];
  /** Locked objects that have no entry at all. */
  readonly missingReferencedCount: number;
  readonly removable: readonly CacheFile[];
  readonly unknownNames: readonly string[];
}

/** What a prune removed; `error` says why it stopped early, with everything removed until then. */
export interface PruneRemoval {
  readonly removed: readonly CacheFile[];
  readonly error?: PipelineError;
}

/** A referenced entry with the locked object it must hold. */
interface ReferencedEntry {
  readonly file: CacheFile;
  readonly object: PlannedObject;
}

/** How an inspection hashes the referenced entries. */
export interface IntegrityCheck {
  readonly concurrency: number;
  readonly signal?: AbortSignal | undefined;
}

/** The referenced entries that are there but wrong; one that vanished meanwhile is not corrupt. */
async function corruptAmong(
  layout: CacheLayout,
  referenced: readonly ReferencedEntry[],
  check: IntegrityCheck,
): Promise<CacheFile[]> {
  const states = await mapBounded(referenced, check.concurrency, ({ object }) => {
    throwIfCancelled(check.signal);
    return checkCachedOriginal(layout, object);
  });
  return referenced.filter((_entry, index) => states[index] === 'corrupt').map(({ file }) => file);
}

function referencedEntriesOf(
  files: readonly CacheFile[],
  locked: ReadonlyMap<string, PlannedObject>,
): ReferencedEntry[] {
  return files.flatMap((file) => {
    const object = file.kind === 'entry' ? locked.get(sha256OfEntry(file)) : undefined;
    return object === undefined ? [] : [{ file, object }];
  });
}

function isDerivativeOf(file: CacheFile, locked: ReadonlyMap<string, PlannedObject>): boolean {
  const isDerivative = file.kind === 'derivative' || file.kind === 'derivativeRecord';
  return isDerivative && locked.has(sourceSha256OfDerivativeName(basename(file.path)));
}

/**
 * Decides from the lock and the cache's own names; storage is not consulted. Reads only. With
 * `integrity`, the referenced entries are hashed too, each checked for cancellation first.
 */
export async function planPrune(
  layout: CacheLayout,
  lock: SourceLock,
  integrity?: IntegrityCheck,
): Promise<PrunePlan> {
  const locked = new Map(lockedObjectsOf(lock).map((object) => [object.sha256, object]));
  const { files, unknownNames } = await inventoryCache(layout);
  const referenced = referencedEntriesOf(files, locked);
  const referencedDerivatives = files.filter((file) => isDerivativeOf(file, locked));
  const kept = new Set([...referenced.map(({ file }) => file), ...referencedDerivatives]);
  return {
    referenced: referenced.map(({ file }) => file),
    referencedDerivatives,
    ...(integrity === undefined
      ? {}
      : { corruptReferenced: await corruptAmong(layout, referenced, integrity) }),
    missingReferencedCount: locked.size - referenced.length,
    removable: files.filter((file) => !kept.has(file)),
    unknownNames,
  };
}

/** Removes one file (never a directory); false when it was already gone. */
async function removeFile(file: CacheFile): Promise<boolean> {
  try {
    await rm(file.path);
    return true;
  } catch (error) {
    if (toPipelineError(error).code === 'NOT_FOUND') return false;
    throw error;
  }
}

async function removeOneUnlessCancelled(
  file: CacheFile,
  signal: AbortSignal | undefined,
  removed: CacheFile[],
): Promise<void> {
  throwIfCancelled(signal);
  if (await removeFile(file)) removed.push(file);
}

/**
 * Removes the plan's removable files one by one, regular files only and never recursively. The
 * caller holds the exclusive claim. Cancellation or a failure stops it; the result then lists
 * exactly what this run removed, as the directories themselves are the only record of what the
 * cache holds.
 */
export async function removePlannedFiles(
  plan: PrunePlan,
  signal: AbortSignal | undefined,
): Promise<PruneRemoval> {
  const removed: CacheFile[] = [];
  try {
    // Also with nothing to remove, a Ctrl+C during the listing ends as CANCELLED.
    throwIfCancelled(signal);
    for (const file of plan.removable) await removeOneUnlessCancelled(file, signal, removed);
    return { removed };
  } catch (error) {
    return { removed, error: toPipelineError(error) };
  }
}
