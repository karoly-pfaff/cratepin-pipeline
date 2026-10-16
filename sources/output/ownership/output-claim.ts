import { rm, rmdir } from 'node:fs/promises';

import { PipelineError, toPipelineError } from '../../errors.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import {
  claimUnlessLive,
  isClaimLive,
  readClaimsIn,
  removeDeadClaimsInProgress,
} from '../../cache/cache-claims.ts';
import type { CacheClaim } from '../../cache/cache-claims.ts';
import { ensureDirectory } from '../../paths/files/create-only-files.ts';
import { workDirectoryOf } from '../layout/work-directory.ts';

/**
 * Holds an output root for one build. Each config's builds already keep each other out through
 * its cache, but two configs that publish into one root with separate caches would not see each
 * other there; this claim, in the work directory next to the root, keeps them apart too.
 */
export interface OutputClaim {
  readonly file: string;
  /** Removes the claim, then the claims and work directories once nothing else is in them. */
  readonly release: () => Promise<void>;
}

/** Why a build stops at a link or file where its work directory or claims belong. */
export const WORK_DIRECTORY_NOT_A_DIRECTORY = 'WORK_DIRECTORY_NOT_A_DIRECTORY';

/**
 * A link or file where the work directory or its claims belong: nothing is written through it,
 * so a build stops before claiming the root, and the dry run and doctor say so too. Read only.
 */
export async function workDirectoryRefusal(outputRoot: string): Promise<PipelineError | undefined> {
  const { directory, claims } = workDirectoryOf(outputRoot);
  for (const path of [directory, claims]) {
    const kind = await entryKindAt(path);
    if (kind === 'absent') return undefined;
    if (kind !== 'directory') {
      return new PipelineError(
        'OUTPUT_CONFLICT',
        `A file or link is where the build's work directory belongs; nothing was changed. Remove ${path}.`,
        { reason: WORK_DIRECTORY_NOT_A_DIRECTORY, path },
      );
    }
  }
  return undefined;
}

/**
 * Claims of builds that ended without releasing them, and the temporary files of claims a crash
 * left half done; their names are never reused.
 */
async function removeDeadBuildClaims(claims: string, own: CacheClaim): Promise<void> {
  const others = (await readClaimsIn(claims)).filter((found) => found.file !== own.file);
  const dead = others.filter((found) => !isClaimLive(found.owner));
  await Promise.all(dead.map((found) => rm(found.file, { force: true })));
  await removeDeadClaimsInProgress(claims);
}

function ignoreTidyingFailure(): void {
  // Dead claims only take room; a later build removes what this one could not.
}

/** Removes `directory` if it is a real directory with nothing in it; a link there stays. */
async function removeIfEmptyDirectory(directory: string): Promise<void> {
  if ((await entryKindAt(directory)) !== 'directory') return;
  await rmdir(directory).catch(() => undefined);
}

/**
 * Removes the claims and work directories if they are real and nothing else is in them; behind a
 * link at the work directory nothing is removed.
 */
async function removeEmptyDirectories(work: string, claims: string): Promise<void> {
  if ((await entryKindAt(work)) !== 'directory') return;
  await removeIfEmptyDirectory(claims);
  await removeIfEmptyDirectory(work);
}

async function claimInDirectories(work: string, claims: string): Promise<CacheClaim> {
  await ensureDirectory(work);
  await ensureDirectory(claims);
  return claimUnlessLive(claims, { kind: 'build', command: 'build' }, ['build']);
}

/** How often a claim is tried again after another build's release removed its directories. */
const CLAIM_ATTEMPTS = 3;

/**
 * Whether `error` came from another build releasing its claim meanwhile: its release removes the
 * claims and work directories once empty, also between this build's steps.
 */
async function isRemovedMeanwhile(error: unknown, claims: string): Promise<boolean> {
  const { code } = toPipelineError(error);
  if (code === 'NOT_FOUND') return true;
  // A directory made, then found gone before it was checked: `ensureDirectory` calls that a conflict.
  return code === 'OUTPUT_CONFLICT' && (await entryKindAt(claims)) === 'absent';
}

async function claimRetryingRemovedDirectories(
  work: string,
  claims: string,
  attempt = 1,
): Promise<CacheClaim> {
  try {
    return await claimInDirectories(work, claims);
  } catch (error) {
    if (attempt >= CLAIM_ATTEMPTS || !(await isRemovedMeanwhile(error, claims))) throw error;
    return claimRetryingRemovedDirectories(work, claims, attempt + 1);
  }
}

/**
 * Claims `outputRoot` for a build: a live build claim of any config makes this one withdraw with
 * OUTPUT_CONFLICT naming its claim file (at worst two starting builds both back off); claims of
 * builds that died are removed when they can be. Nothing is written through a link in place of
 * the directories. When another config's build releases its claim and removes the directories
 * meanwhile, the claim is made again; a claim that backs off leaves no empty directories.
 */
export async function claimOutputForBuild(outputRoot: string): Promise<OutputClaim> {
  const refusal = await workDirectoryRefusal(outputRoot);
  if (refusal !== undefined) throw refusal;
  const { directory: work, claims } = workDirectoryOf(outputRoot);
  const claim = await claimRetryingRemovedDirectories(work, claims).catch(
    async (error: unknown) => {
      await removeEmptyDirectories(work, claims);
      throw error;
    },
  );
  await removeDeadBuildClaims(claims, claim).catch(ignoreTidyingFailure);
  return {
    file: claim.file,
    release: async () => {
      await claim.release();
      await removeEmptyDirectories(work, claims);
    },
  };
}
