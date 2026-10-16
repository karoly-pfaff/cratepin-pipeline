import { lstat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { compareCodeUnits } from '../catalog/ordering.ts';
import { PipelineError, toPipelineError } from '../errors.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import { mapBounded } from '../storage/transfer/bounded-tasks.ts';
import { claimKindOf, isCacheName, namesInCacheDirectory } from './cache-file-names.ts';
import { cacheDirectoriesOf } from './cache-layout.ts';
import type { CacheLayout } from './cache-layout.ts';

/**
 * What a file in the cache is: an `entry` of an original (verified or not), a `derivative`'s
 * output or its `derivativeRecord`, a download or conversion `part`, a `quarantined` file, or a
 * `temporary` marker or claim file, which a crashed run leaves behind or a starting run is
 * writing at this moment.
 */
type CacheFileKind =
  'entry' | 'derivative' | 'derivativeRecord' | 'part' | 'quarantined' | 'temporary';

export interface CacheFile {
  readonly kind: CacheFileKind;
  readonly path: string;
  /** Forward-slash path relative to the cache root, for reports. */
  readonly name: string;
  readonly bytes: number;
}

/** Every file the cache layout names, and every other name, which is never touched. */
export interface CacheInventory {
  readonly files: readonly CacheFile[];
  readonly unknownNames: readonly string[];
}

/** How a name in one cache directory is read: a file kind, part of the layout itself, or foreign. */
type NameReading = CacheFileKind | 'layout' | undefined;

interface DirectoryRule {
  readonly directory: string;
  readonly readName: (name: string) => NameReading;
}

function kindIfNamed(kind: Exclude<CacheFileKind, 'temporary'>, name: string): NameReading {
  return isCacheName(kind, name) ? kind : undefined;
}

function derivativesDirectoryReading(name: string): NameReading {
  return kindIfNamed('derivative', name) ?? kindIfNamed('derivativeRecord', name);
}

function claimsDirectoryReading(name: string): NameReading {
  // Claim files belong to their runs: only the exclusive claim removes them, by liveness.
  if (claimKindOf(name) !== undefined) return 'layout';
  return isCacheName('claimInProgress', name) ? 'temporary' : undefined;
}

function directoryRulesOf(layout: CacheLayout): DirectoryRule[] {
  const layoutNames = new Set(
    [layout.markerFile, ...cacheDirectoriesOf(layout)].map(
      (path) => relative(layout.root, path).split(sep)[0],
    ),
  );
  const rootReading = (name: string): NameReading => {
    if (layoutNames.has(name)) return 'layout';
    return isCacheName('markerInProgress', name) ? 'temporary' : undefined;
  };
  return [
    { directory: layout.root, readName: rootReading },
    {
      directory: dirname(layout.originals),
      readName: (name) => (name === basename(layout.originals) ? 'layout' : undefined),
    },
    { directory: layout.originals, readName: (name) => kindIfNamed('entry', name) },
    { directory: layout.derivatives, readName: derivativesDirectoryReading },
    { directory: layout.incoming, readName: (name) => kindIfNamed('part', name) },
    { directory: layout.quarantine, readName: (name) => kindIfNamed('quarantined', name) },
    { directory: layout.claims, readName: claimsDirectoryReading },
  ];
}

/**
 * A cache directory must be a real directory: through a link or junction, a prune would remove
 * files somewhere else. A missing one (a cache made before it existed) holds nothing.
 */
async function isPresentRealDirectory(directory: string): Promise<boolean> {
  const kind = await entryKindAt(directory);
  if (kind === 'directory') return true;
  if (kind === 'absent') return false;
  if (kind === 'unreadable') {
    throw new PipelineError('IO_FAILED', 'A cache directory cannot be inspected.', {
      path: directory,
    });
  }
  throw new PipelineError(
    'OUTPUT_CONFLICT',
    'A cache directory is not a real directory (a link, junction or file); nothing was removed.',
    { path: directory },
  );
}

/**
 * Fails unless every cache directory that exists is a real directory; a prune checks this before
 * it takes its claim, so a refusal really has removed nothing.
 */
export async function assertCacheDirectoriesReal(layout: CacheLayout): Promise<void> {
  for (const rule of directoryRulesOf(layout)) await isPresentRealDirectory(rule.directory);
}

/** Names looked at, at most, at the same time while listing one directory. */
const LISTING_CONCURRENCY = 32;

/** The entry's own metadata, never following a link; `undefined` when it vanished meanwhile. */
async function statOf(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (toPipelineError(error).code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

function relativeName(layout: CacheLayout, path: string): string {
  return relative(layout.root, path).split(sep).join('/');
}

interface ReadEntry {
  readonly file?: CacheFile;
  readonly unknownName?: string;
}

/** One name: a CacheFile when the layout names it and it is a regular file, else unknown. */
async function readEntry(
  layout: CacheLayout,
  path: string,
  reading: NameReading,
): Promise<ReadEntry> {
  const stats = await statOf(path);
  if (stats === undefined || reading === 'layout') return {};
  const name = relativeName(layout, path);
  if (reading === undefined || !stats.isFile()) return { unknownName: name };
  return { file: { kind: reading, path, name, bytes: stats.size } };
}

/** Lists one directory without following, opening or hashing anything. */
async function listDirectory(layout: CacheLayout, rule: DirectoryRule): Promise<CacheInventory> {
  if (!(await isPresentRealDirectory(rule.directory))) return { files: [], unknownNames: [] };
  const names = await namesInCacheDirectory(rule.directory);
  const entries = await mapBounded(names, LISTING_CONCURRENCY, (name) =>
    readEntry(layout, join(rule.directory, name), rule.readName(name)),
  );
  return {
    files: entries.flatMap(({ file }) => (file === undefined ? [] : [file])),
    unknownNames: entries.flatMap(({ unknownName }) =>
      unknownName === undefined ? [] : [unknownName],
    ),
  };
}

/**
 * Every file of the cache by kind, and every name the layout does not explain; reads only. Fails
 * with OUTPUT_CONFLICT when a cache directory is a link, junction or file.
 */
export async function inventoryCache(layout: CacheLayout): Promise<CacheInventory> {
  const listings: CacheInventory[] = [];
  for (const rule of directoryRulesOf(layout)) listings.push(await listDirectory(layout, rule));
  return {
    files: listings
      .flatMap(({ files }) => files)
      .toSorted((left, right) => compareCodeUnits(left.name, right.name)),
    unknownNames: listings.flatMap(({ unknownNames }) => unknownNames).toSorted(compareCodeUnits),
  };
}

/** The SHA-256 an entry file is named by. */
export function sha256OfEntry(file: CacheFile): string {
  return basename(file.path);
}
