import { join } from 'node:path';

import { PipelineError } from '../errors.ts';
import { isSha256Hex } from '../lock/lock-validation.ts';

/**
 * Where one project's verified cache keeps everything. Every name below the root is chosen by
 * this tool; remote object keys never become local paths.
 */
export interface CacheLayout {
  readonly root: string;
  /** Says which project's cache this is, so a foreign directory is never adopted. */
  readonly markerFile: string;
  /** Verified originals, each named by its SHA-256. */
  readonly originals: string;
  /**
   * Converted outputs and their records, `<source sha256>.<key>` and `<source sha256>.<key>.json`,
   * named by the source they came from so a prune can tell which ones the lock still needs.
   */
  readonly derivatives: string;
  /** Downloads and conversions in progress, `<sha256 or key>.<uuid>.part`; never read as entries. */
  readonly incoming: string;
  /** Entries that failed verification, moved out of the way; never served again. */
  readonly quarantine: string;
  /** One file per running pull, build or prune, `<use|build|prune>-<uuid>.json`. */
  readonly claims: string;
}

export function cacheLayoutOf(cacheRoot: string): CacheLayout {
  return {
    root: cacheRoot,
    markerFile: join(cacheRoot, 'cratepin-cache.json'),
    originals: join(cacheRoot, 'originals', 'sha256'),
    derivatives: join(cacheRoot, 'derivatives'),
    incoming: join(cacheRoot, 'incoming'),
    quarantine: join(cacheRoot, 'quarantine'),
    claims: join(cacheRoot, 'claims'),
  };
}

/** The directories a usable cache has, parents first. */
export function cacheDirectoriesOf(layout: CacheLayout): string[] {
  return [
    join(layout.root, 'originals'),
    layout.originals,
    layout.derivatives,
    layout.incoming,
    layout.quarantine,
    layout.claims,
  ];
}

/** The entry of an original: only a validated SHA-256 hex digest ever becomes a file name. */
export function originalPathOf(layout: CacheLayout, sha256: string): string {
  if (isSha256Hex(sha256)) return join(layout.originals, sha256);
  throw new PipelineError('INVALID_DATA', 'Cache entries are named by a SHA-256 hex digest.', {
    sha256,
  });
}
