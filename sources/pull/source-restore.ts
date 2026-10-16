import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { readCachedOriginal } from '../cache/cached-originals.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { compareCodeUnits } from '../catalog/ordering.ts';
import { PipelineError, throwIfCancelled, toPipelineError } from '../errors.ts';
import { hashOpenedFile } from '../opened-file-hash.ts';
import type { SourceLock, SourceRecord } from '../lock/source-lock.ts';
import { assertLayoutStillSafe } from '../paths/layout/checked-project.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { ensureDirectory, linkIfAbsent, writeNewFile } from '../paths/files/create-only-files.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import { openSourceFile } from '../paths/files/source-file-opening.ts';
import { withContentCheck } from '../storage/transfer/checked-body.ts';

/**
 * What restoring would do to each locked source file, by source path: write a missing one, leave
 * an identical one, and keep one that differs (an edit, or anything that is not a regular file).
 */
export interface SourceRestorePlan {
  readonly missing: readonly SourceRecord[];
  readonly unchanged: readonly string[];
  readonly kept: readonly string[];
}

/** What a restore did: the sources written now, and those left as they were. */
export interface SourceRestoreResult {
  readonly restored: readonly string[];
  readonly unchanged: readonly string[];
  readonly kept: readonly string[];
  /** Why the restore stopped early; the lists say what was done until then. */
  readonly error?: PipelineError;
}

type SourceState = 'missing' | 'unchanged' | 'kept';

function sourcePathOf(project: CheckedProject, record: SourceRecord): string {
  return join(project.paths.sourceRoot, ...record.source.split('/'));
}

async function isIdenticalFile(path: string, record: SourceRecord): Promise<boolean> {
  const file = await openSourceFile(path);
  try {
    const digest = await hashOpenedFile(file, record.bytes + 1);
    return digest.bytes === record.bytes && digest.sha256 === record.sha256;
  } finally {
    await file.close();
  }
}

async function sourceStateOf(project: CheckedProject, record: SourceRecord): Promise<SourceState> {
  const path = sourcePathOf(project, record);
  const kind = await entryKindAt(path);
  if (kind === 'absent') return 'missing';
  if (kind === 'unreadable') {
    throw new PipelineError('IO_FAILED', 'A source file cannot be inspected.', { path });
  }
  if (kind !== 'file') return 'kept';
  return (await isIdenticalFile(path, record)) ? 'unchanged' : 'kept';
}

interface PlanInProgress {
  readonly missing: SourceRecord[];
  readonly unchanged: string[];
  readonly kept: string[];
}

function emptyPlan(): PlanInProgress {
  return { missing: [], unchanged: [], kept: [] };
}

/**
 * Compares every locked source with the source directory, one file at a time; reads only. The
 * findings go into `plan` as they are made, so a caller still has them when this fails.
 */
export async function planSourceRestore(
  project: CheckedProject,
  lock: SourceLock,
  { signal, plan = emptyPlan() }: { signal?: AbortSignal | undefined; plan?: PlanInProgress } = {},
): Promise<SourceRestorePlan> {
  const records = lock.assets.toSorted((left, right) =>
    compareCodeUnits(left.source, right.source),
  );
  for (const record of records) {
    throwIfCancelled(signal);
    const state = await sourceStateOf(project, record);
    if (state === 'missing') plan.missing.push(record);
    else plan[state].push(record.source);
  }
  return plan;
}

/** Creates the directories below the source root that `source` needs; never through a link. */
async function ensureSourceDirectories(project: CheckedProject, source: string): Promise<void> {
  const segments = source.split('/').slice(0, -1);
  let path = project.paths.sourceRoot;
  for (const segment of segments) {
    path = join(path, segment);
    await ensureDirectory(path);
  }
}

function restoreMismatch(record: SourceRecord): PipelineError {
  return new PipelineError(
    'INTEGRITY_MISMATCH',
    'The cache entry changed after it was verified; the source was not restored.',
    { sha256: record.sha256 },
  );
}

/** A restore of the sources a plan found missing, from the project's verified cache. */
export interface SourceRestore {
  readonly project: CheckedProject;
  readonly layout: CacheLayout;
  readonly plan: SourceRestorePlan;
  readonly signal?: AbortSignal | undefined;
}

type RestoredState = 'restored' | 'unchanged' | 'kept';

/** The name a restore gives its temporary file after `.<source name>`. */
const RESTORE_SUFFIX = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.restore$/u;

/** A restore still running keeps writing its file, so one untouched this long was abandoned. */
const ABANDONED_RESTORE_AGE_MS = 60 * 60 * 1000;

/** Whether `path` is a regular file untouched for an hour; a file already gone is not. */
async function isAbandonedFile(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile() && Date.now() - entry.mtimeMs > ABANDONED_RESTORE_AGE_MS;
  } catch (error) {
    if (toPipelineError(error).code === 'NOT_FOUND') return false;
    throw error;
  }
}

/**
 * Removes temporary files a crashed restore of `target` left next to it: regular files of exactly
 * that name only, untouched for an hour, never through a link and never an author's file. A file
 * another pull is still writing is younger and stays.
 */
async function removeStaleRestores(target: string): Promise<void> {
  const prefix = `.${basename(target)}`;
  const stale = (await readdir(dirname(target))).filter(
    (name) => name.startsWith(prefix) && RESTORE_SUFFIX.test(name.slice(prefix.length)),
  );
  for (const name of stale) {
    const path = join(dirname(target), name);
    if (await isAbandonedFile(path)) await rm(path, { force: true });
  }
}

/**
 * Copies the verified cache entry into a hidden temporary file next to the target, checking the
 * bytes again on the way, and gives it the source's name only if that is still free. Returns
 * false when someone created the file meanwhile.
 */
async function copyIntoPlace(restore: SourceRestore, record: SourceRecord): Promise<boolean> {
  const target = sourcePathOf(restore.project, record);
  const temporaryPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.restore`);
  try {
    const cached = readCachedOriginal(restore.layout, record.sha256);
    const bytes = withContentCheck(cached, record, () => restoreMismatch(record));
    await writeNewFile(temporaryPath, bytes, restore.signal);
    return await linkIfAbsent(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Writes one missing source; a file someone created meanwhile stays and is compared instead. */
async function restoreOne(restore: SourceRestore, record: SourceRecord): Promise<RestoredState> {
  await ensureSourceDirectories(restore.project, record.source);
  await removeStaleRestores(sourcePathOf(restore.project, record));
  if (await copyIntoPlace(restore, record)) return 'restored';
  return (await sourceStateOf(restore.project, record)) === 'unchanged' ? 'unchanged' : 'kept';
}

type RestoreProgress = Record<RestoredState, string[]>;

async function restoreEachMissing(
  restore: SourceRestore,
  progress: RestoreProgress,
): Promise<void> {
  for (const record of restore.plan.missing) {
    throwIfCancelled(restore.signal);
    progress[await restoreOne(restore, record)].push(record.source);
  }
}

/**
 * Restores the locked sources that are missing from the source directory, one by one, from the
 * verified cache. Existing files are never replaced: identical ones stay, different ones (an
 * author's edit) are kept and listed. The layout is checked again before anything is written.
 * A failure or cancellation stops the restore; the result then still says what was done.
 */
export async function restoreSources(restore: SourceRestore): Promise<SourceRestoreResult> {
  const { project, plan } = restore;
  const progress = { restored: [], unchanged: [...plan.unchanged], kept: [...plan.kept] };
  try {
    await assertLayoutStillSafe(project, 'no source was restored');
    if (plan.missing.length > 0) await mkdir(project.paths.sourceRoot, { recursive: true });
    await restoreEachMissing(restore, progress);
    return progress;
  } catch (error) {
    return { ...progress, error: toPipelineError(error) };
  }
}

/**
 * Plans and runs the restore of a pull. A failure or cancellation while comparing the existing
 * sources is returned like one while writing them, with what was compared until then, so the
 * pull still reports what it cached.
 */
export async function planAndRestoreSources(
  restore: Omit<SourceRestore, 'plan'> & { readonly lock: SourceLock },
): Promise<SourceRestoreResult> {
  const plan = emptyPlan();
  try {
    await planSourceRestore(restore.project, restore.lock, { signal: restore.signal, plan });
  } catch (error) {
    const { unchanged, kept } = plan;
    return { restored: [], unchanged, kept, error: toPipelineError(error) };
  }
  return restoreSources({ ...restore, plan });
}
