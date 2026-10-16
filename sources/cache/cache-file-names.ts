import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { toPipelineError } from '../errors.ts';
import type { CacheLayout } from './cache-layout.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHA256 = '[0-9a-f]{64}';

/**
 * Every file name the cache gives, one pattern per kind. The writers below build names only
 * through these functions, and prune recognizes files only by these patterns, so the two cannot
 * drift apart; any other name in the cache is foreign and never touched.
 */
const NAME_PATTERNS = {
  entry: new RegExp(`^${SHA256}$`, 'u'),
  derivative: new RegExp(`^${SHA256}\\.${SHA256}$`, 'u'),
  derivativeRecord: new RegExp(`^${SHA256}\\.${SHA256}\\.json$`, 'u'),
  part: new RegExp(`^${SHA256}\\.${UUID}\\.part$`, 'u'),
  quarantined: new RegExp(`^${SHA256}\\.${UUID}$`, 'u'),
  markerInProgress: new RegExp(`^cratepin-cache\\.json\\.${UUID}\\.tmp$`, 'u'),
  claimInProgress: new RegExp(`^\\.${UUID}\\.tmp$`, 'u'),
  claim: new RegExp(`^(use|build|prune)-${UUID}\\.json$`, 'u'),
} as const;

export type CacheNameKind = keyof typeof NAME_PATTERNS;

export function isCacheName(kind: CacheNameKind, name: string): boolean {
  return NAME_PATTERNS[kind].test(name);
}

const CLAIM_KINDS: ReadonlySet<string> = new Set(['use', 'build', 'prune']);

/** `use`, `build` or `prune` for a claim file name, `undefined` for anything else. */
export function claimKindOf(name: string): 'use' | 'build' | 'prune' | undefined {
  const kind = NAME_PATTERNS.claim.exec(name)?.[1];
  return kind !== undefined && CLAIM_KINDS.has(kind)
    ? (kind as 'use' | 'build' | 'prune')
    : undefined;
}

/**
 * A new download's or conversion's private part file, named by the digest it is for (an
 * original's SHA-256 or a derivative key), which must already be validated.
 */
export function partPathOf(layout: CacheLayout, sha256: string): string {
  return join(layout.incoming, `${sha256}.${randomUUID()}.part`);
}

/** Where one derivative's output bytes and its record are kept. */
export interface DerivativePaths {
  readonly output: string;
  readonly record: string;
}

/** The files of the derivative `key` of the source `sourceSha256`; both must be validated digests. */
export function derivativePathsOf(
  layout: CacheLayout,
  sourceSha256: string,
  key: string,
): DerivativePaths {
  const output = join(layout.derivatives, `${sourceSha256}.${key}`);
  return { output, record: `${output}.json` };
}

/** The SHA-256 of the source a derivative file was made from, read from its name. */
export function sourceSha256OfDerivativeName(name: string): string {
  return name.slice(0, 64);
}

/** A new unique name in the quarantine for an entry that failed verification. */
export function quarantinePathOf(layout: CacheLayout, sha256: string): string {
  return join(layout.quarantine, `${sha256}.${randomUUID()}`);
}

export function markerInProgressPathOf(layout: CacheLayout): string {
  return `${layout.markerFile}.${randomUUID()}.tmp`;
}

/** A new claim file of `kind` in a claims directory. */
export function claimPathOf(claims: string, kind: 'use' | 'build' | 'prune'): string {
  return join(claims, `${kind}-${randomUUID()}.json`);
}

export function claimInProgressPathOf(claims: string): string {
  return join(claims, `.${randomUUID()}.tmp`);
}

/** A cache directory's names; none when it does not exist (a cache made before it was added). */
export async function namesInCacheDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (toPipelineError(error).code === 'NOT_FOUND') return [];
    throw error;
  }
}
