import type { ExpectedContent } from '../storage/transfer/checked-body.ts';
import { quarantinePathOf } from './cache-file-names.ts';
import { checkCacheFile, quarantineCacheFile, streamCacheFile } from './cache-files.ts';
import type { EntryState } from './cache-files.ts';
import { originalPathOf } from './cache-layout.ts';
import type { CacheLayout } from './cache-layout.ts';

/**
 * Checks the cache entry of an original, which is named by the hash it must have, by hashing all
 * of it; see `checkCacheFile`.
 */
export function checkCachedOriginal(
  layout: CacheLayout,
  expected: ExpectedContent,
): Promise<EntryState> {
  return checkCacheFile(originalPathOf(layout, expected.sha256), expected);
}

/** Quarantines a corrupt entry of an original; see `quarantineCacheFile`. */
export function quarantineOriginal(
  layout: CacheLayout,
  expected: ExpectedContent,
): Promise<boolean> {
  return quarantineCacheFile(
    {
      from: originalPathOf(layout, expected.sha256),
      to: quarantinePathOf(layout, expected.sha256),
    },
    expected,
  );
}

/** Streams a cache entry's bytes; callers that need them exact pass them through a content check. */
export function readCachedOriginal(
  layout: CacheLayout,
  sha256: string,
): AsyncGenerator<Uint8Array> {
  return streamCacheFile(originalPathOf(layout, sha256));
}
