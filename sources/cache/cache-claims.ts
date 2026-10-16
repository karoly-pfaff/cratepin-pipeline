import { rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readTextWithin } from '../paths/files/bounded-text.ts';

import { PipelineError, toPipelineError } from '../errors.ts';
import { parseStrictJson } from '../json/strict-json.ts';
import { linkIfAbsent } from '../paths/files/create-only-files.ts';
import {
  claimInProgressPathOf,
  claimKindOf,
  claimPathOf,
  isCacheName,
  namesInCacheDirectory,
} from './cache-file-names.ts';
import type { CacheLayout } from './cache-layout.ts';

/**
 * `use` claims are shared (pulls); a `build` claim also excludes other builds, as one output root
 * belongs to one cache; a `prune` claim needs the cache to itself.
 */
type ClaimKind = 'use' | 'build' | 'prune';

/** What a claim file records about the run that wrote it. */
export interface ClaimOwner {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
}

/** A claim file of another run, as found in the claims directory. */
export interface FoundClaim {
  readonly file: string;
  readonly kind: ClaimKind;
  /** `undefined` when the file cannot be read as a claim; such a claim counts as live. */
  readonly owner: ClaimOwner | undefined;
}

/** This run's claim; `release` removes its file and may be called more than once. */
export interface CacheClaim {
  readonly file: string;
  readonly release: () => Promise<void>;
}

function isClaimOwner(value: unknown): value is ClaimOwner {
  if (typeof value !== 'object' || value === null) return false;
  const { pid, host, command } = value as Partial<Record<keyof ClaimOwner, unknown>>;
  return Number.isSafeInteger(pid) && typeof host === 'string' && typeof command === 'string';
}

function ownerOf(text: string): ClaimOwner | undefined {
  const parsed = parseStrictJson(text);
  return parsed.ok && isClaimOwner(parsed.value) ? parsed.value : undefined;
}

/** A claim file's content as read: gone (its run withdrew or ended), or its owner if readable. */
type ClaimReading =
  { readonly isGone: true } | { readonly isGone: false; readonly owner?: ClaimOwner };

/** A claim holds a PID, host, command and start time; a larger file is not one this tool wrote. */
const MAX_CLAIM_BYTES = 4096;

/**
 * Claims are linked into place whole, so one that cannot be read was not written by this tool's
 * claim writer (or is damaged); it counts as live. One that vanished since the listing is gone.
 */
async function readClaim(file: string): Promise<ClaimReading> {
  try {
    const text = await readTextWithin(file, MAX_CLAIM_BYTES);
    const owner = text === undefined ? undefined : ownerOf(text);
    return owner === undefined ? { isGone: false } : { isGone: false, owner };
  } catch (error) {
    return { isGone: toPipelineError(error).code === 'NOT_FOUND' };
  }
}

/** Every claim file in a claims directory; names this tool does not write are ignored. */
export async function readClaimsIn(directory: string): Promise<FoundClaim[]> {
  const claims: FoundClaim[] = [];
  for (const name of await namesInCacheDirectory(directory)) {
    const kind = claimKindOf(name);
    const file = join(directory, name);
    const reading = kind === undefined ? undefined : await readClaim(file);
    if (kind !== undefined && reading?.isGone === false) {
      claims.push({ file, kind, owner: reading.owner });
    }
  }
  return claims;
}

/** Every claim file in the cache; names this tool does not write are ignored. */
export function readAllClaims(layout: CacheLayout): Promise<FoundClaim[]> {
  return readClaimsIn(layout.claims);
}

/** Every claim file except this run's own. */
async function readOtherClaims(directory: string, ownFile: string): Promise<FoundClaim[]> {
  return (await readClaimsIn(directory)).filter((found) => found.file !== ownFile);
}

/** The checked fields of a readable claim, for reports; a claim file may hold anything else. */
export function ownerDetailsOf({ owner }: FoundClaim): Readonly<Record<string, string | number>> {
  return owner === undefined ? {} : { command: owner.command, pid: owner.pid, host: owner.host };
}

/**
 * Whether the run that wrote a claim may still be running. Only a process on this host that the
 * operating system says does not exist (ESRCH) is dead; a claim from another host, an unreadable
 * claim, this very process, or a process this run may not signal counts as live. Age never
 * matters: a long download is not stale. A claim that only looks live (another host, a reused
 * process ID) keeps a prune from running, keeps builds out if it is a build or prune claim, and
 * keeps pulls out too if it is a prune claim, until someone who checked removes its file; the
 * conflict names that file.
 */
export function isClaimLive(owner: ClaimOwner | undefined): boolean {
  if (owner?.host !== hostname() || owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== 'ESRCH';
  }
}

/**
 * Writes the claim under a temporary name (which no reader looks at) and links it into place, so
 * a claim is never seen half written, even after a crash. A temporary file that cannot be removed
 * right away does not fail the claim; releasing tries again. One a crash left goes with
 * `cache prune` in the cache, and with a later output claim next to an output root once its owner
 * is dead or, torn before the owner was written, it is a minute old (`removeDeadClaimsInProgress`).
 */
async function writeClaim(
  directory: string,
  kind: ClaimKind,
  command: string,
): Promise<CacheClaim> {
  const file = claimPathOf(directory, kind);
  const owner = {
    pid: process.pid,
    host: hostname(),
    command,
    startedAt: new Date().toISOString(),
  };
  const temporaryPath = claimInProgressPathOf(directory);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(owner)}\n`, { flag: 'wx', flush: true });
    await linkIfAbsent(temporaryPath, file);
  } finally {
    await rm(temporaryPath, { force: true }).catch(ignoreLeftoverTemporaryFile);
  }
  return {
    file,
    release: async () => {
      await rm(file, { force: true });
      await rm(temporaryPath, { force: true });
    },
  };
}

function ignoreLeftoverTemporaryFile(): void {
  // Releasing the claim removes it, or a later run once its owner is dead.
}

/**
 * Removes the claims in progress (temporary files of `writeClaim`) whose run is dead: a crash
 * between writing one and removing it left it. A live run's file stays; it is gone in moments.
 */
export async function removeDeadClaimsInProgress(directory: string): Promise<void> {
  const names = await namesInCacheDirectory(directory);
  for (const name of names.filter((entry) => isCacheName('claimInProgress', entry))) {
    const file = join(directory, name);
    if (await isAbandonedClaimInProgress(file)) await rm(file, { force: true });
  }
}

/** A claim being written is written in moments; one without an owner this old was torn. */
const TORN_CLAIM_AGE_MS = 60_000;

/**
 * Whether a claim in progress was left by a run that is gone: its owner is dead, or a crash tore
 * it before its owner was written and it has not changed for a minute.
 */
async function isAbandonedClaimInProgress(file: string): Promise<boolean> {
  const reading = await readClaim(file);
  if (reading.isGone) return false;
  if (reading.owner !== undefined) return !isClaimLive(reading.owner);
  const changed = await stat(file).catch(() => undefined);
  return changed !== undefined && Date.now() - changed.mtimeMs > TORN_CLAIM_AGE_MS;
}

/** OUTPUT_CONFLICT naming the claim in the way, so a user can check its run or remove it. */
function claimConflictError(blocking: FoundClaim, message: string): PipelineError {
  return new PipelineError('OUTPUT_CONFLICT', message, {
    claimFile: blocking.file,
    ...ownerDetailsOf(blocking),
  });
}

/** What each kind of live claim holds, for the message of a run it keeps out. */
const HELD_BY: Readonly<Record<ClaimKind, string>> = {
  use: 'the cache',
  build: 'the output',
  prune: 'the cache',
};

/**
 * Writes a claim of `kind` in a claims directory, then withdraws it with OUTPUT_CONFLICT naming
 * the claim file of a live claim of a `blockingKinds` kind; claims of dead runs are ignored.
 */
export async function claimUnlessLive(
  directory: string,
  claimed: { readonly kind: ClaimKind; readonly command: string },
  blockingKinds: readonly ClaimKind[],
): Promise<CacheClaim> {
  const claim = await writeClaim(directory, claimed.kind, claimed.command);
  const others = await readOtherClaims(directory, claim.file);
  const blocking = others.find(
    (found) => blockingKinds.includes(found.kind) && isClaimLive(found.owner),
  );
  if (blocking === undefined) return claim;
  await claim.release();
  throw claimConflictError(
    blocking,
    `A ${blocking.kind} holds ${HELD_BY[blocking.kind]}; run again once it is done. If it is not running, remove claimFile.`,
  );
}

/**
 * Registers a run that uses the cache. Any number may run at once. While a live prune holds the
 * cache, the claim is withdrawn and the run stops with OUTPUT_CONFLICT naming the prune's claim
 * file; the claim of a prune that died is ignored (the next prune removes it).
 */
export function claimCacheUse(layout: CacheLayout, command: string): Promise<CacheClaim> {
  return claimUnlessLive(layout.claims, { kind: 'use', command }, ['prune']);
}

/**
 * Registers a build, which uses the cache like a pull and publishes into the project's output
 * root, so no prune and no other build may run meanwhile: a live prune or build makes this one
 * withdraw with OUTPUT_CONFLICT naming its claim file (at worst two starting builds both back
 * off). Pulls may run alongside; claims of dead runs are ignored.
 */
export function claimCacheForBuild(layout: CacheLayout, command: string): Promise<CacheClaim> {
  return claimUnlessLive(layout.claims, { kind: 'build', command }, ['prune', 'build']);
}

/** An exclusive claim and the claim files of dead runs it removed. */
export interface ExclusiveClaim {
  readonly claim: CacheClaim;
  readonly removedDeadClaimFiles: readonly string[];
}

/**
 * Takes the cache for a run that removes entries. Each side writes its own claim before it looks
 * for the other's, so a prune and a pull can never both go ahead (at worst both back off). Any
 * live claim makes this one withdraw with OUTPUT_CONFLICT; claims of dead runs are removed, which
 * is safe because every claim has a unique name and a dead run never writes again.
 */
export async function claimCacheExclusively(
  layout: CacheLayout,
  command: string,
): Promise<ExclusiveClaim> {
  const claim = await writeClaim(layout.claims, 'prune', command);
  const others = await readOtherClaims(layout.claims, claim.file);
  const live = others.find((found) => isClaimLive(found.owner));
  if (live !== undefined) {
    await claim.release();
    throw claimConflictError(
      live,
      'Another run uses the cache; nothing was removed. If it is not running, remove claimFile.',
    );
  }
  await Promise.all(others.map((found) => rm(found.file, { force: true })));
  return { claim, removedDeadClaimFiles: others.map((found) => found.file) };
}
