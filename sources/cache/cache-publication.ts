import { PipelineError } from '../errors.ts';
import { linkIfAbsent } from '../paths/files/create-only-files.ts';
import type { ExpectedContent } from '../storage/transfer/checked-body.ts';
import { checkCacheFile, quarantineCacheFile } from './cache-files.ts';

/** A complete, verified part file and the cache path it is published under. */
export interface CachePublication {
  readonly part: string;
  readonly path: string;
  /** A new, unique quarantine name for a corrupt file found at `path`. */
  readonly quarantineTarget: () => string;
  readonly expected: ExpectedContent;
}

/** A corrupt file in the way is quarantined once; a second one means someone keeps writing it. */
const PUBLICATION_ATTEMPTS = 2;

/**
 * Gives the verified part file its cache name. When the name is taken, another process published
 * the same content (fine once it verifies) or a corrupt file is in the way, which is quarantined
 * before trying again. The caller removes the part file.
 */
export async function publishVerifiedPart(publication: CachePublication): Promise<void> {
  const { part, path, expected } = publication;
  for (let attempt = 1; attempt <= PUBLICATION_ATTEMPTS; attempt += 1) {
    if (await linkIfAbsent(part, path)) return;
    if ((await checkCacheFile(path, expected)) === 'verified') return;
    const move = { from: path, to: publication.quarantineTarget() };
    if (await quarantineCacheFile(move, expected)) return;
  }
  throw new PipelineError(
    'OUTPUT_CONFLICT',
    'A cache file keeps being replaced by something else; nothing was published.',
    { sha256: expected.sha256 },
  );
}
