import type { BlobReader } from '../blob-store.ts';
import { downloadIntoCache } from '../cache/cache-download.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { checkCachedOriginal, quarantineOriginal } from '../cache/cached-originals.ts';
import type { EntryState } from '../cache/cache-files.ts';
import { throwIfCancelled, toPipelineError } from '../errors.ts';
import type { PipelineError } from '../errors.ts';
import type { PlannedObject } from '../lock/upload-plan.ts';
import { mapBounded } from '../storage/transfer/bounded-tasks.ts';

/**
 * Where a locked original stands after retrieval: `cached` was a verified hit, `downloaded` was
 * fetched and verified now, `missing` is not in the cache and was not fetched (offline), and
 * `failed` could not be fetched.
 */
export type OriginalStatus = 'cached' | 'downloaded' | 'missing' | 'failed';

export interface OriginalOutcome {
  readonly object: PlannedObject;
  readonly status: OriginalStatus;
  /** A corrupt entry was found and moved to the quarantine. */
  readonly wasQuarantined: boolean;
  readonly error?: PipelineError;
}

/** What a retrieval works on; `openReader` is called once, on the first cache miss. */
export interface OriginalsRetrieval {
  readonly layout: CacheLayout;
  readonly objects: readonly PlannedObject[];
  readonly isOffline: boolean;
  readonly openReader: () => BlobReader;
  readonly concurrency: number;
  readonly signal?: AbortSignal | undefined;
}

/** What a read-only check of the cache found per object, without changing anything. */
export interface CacheInspection {
  readonly object: PlannedObject;
  readonly state: EntryState;
}

type Creation<Value> = { readonly value: Value } | { readonly error: unknown };

/** `create` runs on the first call only; its value, or its failure, is returned to every call. */
function once<Value>(create: () => Value): () => Value {
  let creation: Creation<Value> | undefined;
  return () => {
    if (creation === undefined) {
      try {
        creation = { value: create() };
      } catch (error) {
        creation = { error };
      }
    }
    if ('error' in creation) throw creation.error;
    return creation.value;
  };
}

/** Downloads one object; its own failure is recorded, cancellation stops the whole retrieval. */
async function downloadOne(
  retrieval: OriginalsRetrieval,
  reader: BlobReader,
  object: PlannedObject,
): Promise<Pick<OriginalOutcome, 'status' | 'error'>> {
  try {
    await downloadIntoCache({ layout: retrieval.layout, object, reader, signal: retrieval.signal });
    return { status: 'downloaded' };
  } catch (error) {
    const failure = toPipelineError(error);
    if (failure.code === 'CANCELLED') throw failure;
    return { status: 'failed', error: failure };
  }
}

/** Quarantines a corrupt entry; true when another run's verified entry turned out to be there. */
async function isVerifiedAfterQuarantine(
  retrieval: OriginalsRetrieval,
  state: EntryState,
  object: PlannedObject,
): Promise<boolean> {
  return state === 'corrupt' && (await quarantineOriginal(retrieval.layout, object));
}

async function retrieveOne(
  retrieval: OriginalsRetrieval,
  readerOnFirstMiss: () => BlobReader,
  object: PlannedObject,
): Promise<OriginalOutcome> {
  throwIfCancelled(retrieval.signal);
  const state = await checkCachedOriginal(retrieval.layout, object);
  if (state === 'verified' || (await isVerifiedAfterQuarantine(retrieval, state, object))) {
    return { object, status: 'cached', wasQuarantined: false };
  }
  const wasQuarantined = state === 'corrupt';
  if (retrieval.isOffline) return { object, status: 'missing', wasQuarantined };
  return { object, wasQuarantined, ...(await downloadOne(retrieval, readerOnFirstMiss(), object)) };
}

/**
 * Makes every locked original available in the cache as a verified entry. Each is hashed in
 * the cache first; a corrupt entry is quarantined; only misses are downloaded, and only by exact
 * locked key, never by listing storage. Offline, nothing is downloaded and the read transport is
 * never created, so no credential is resolved and no request is sent; online, it is created on
 * the first miss, so a warm cache needs neither. A failed download does not stop the others;
 * cancellation, a transport that cannot be created, or a local cache failure before a download
 * (an entry that cannot be read or quarantined) stops the retrieval; a local failure while
 * publishing a download counts as that object's failure.
 */
export function retrieveLockedOriginals(retrieval: OriginalsRetrieval): Promise<OriginalOutcome[]> {
  const readerOnFirstMiss = once(retrieval.openReader);
  return mapBounded(retrieval.objects, retrieval.concurrency, (object) =>
    retrieveOne(retrieval, readerOnFirstMiss, object),
  );
}

/** Hashes each locked original's cache entry, if there is a cache, and changes nothing. */
export function inspectCachedOriginals(
  layout: CacheLayout | undefined,
  objects: readonly PlannedObject[],
  concurrency: number,
): Promise<CacheInspection[]> {
  return mapBounded(objects, concurrency, async (object) => ({
    object,
    state: layout === undefined ? 'absent' : await checkCachedOriginal(layout, object),
  }));
}
