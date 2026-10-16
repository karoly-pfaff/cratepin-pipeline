import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { readTextWithin } from '../paths/files/bounded-text.ts';

import { PipelineError, toPipelineError } from '../errors.ts';
import { parseStrictJson } from '../json/strict-json.ts';
import { assertLayoutStillSafe } from '../paths/layout/checked-project.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { ensureDirectory, linkIfAbsent } from '../paths/files/create-only-files.ts';
import { entryKindAt } from '../paths/path-containment.ts';
import { isCacheName, markerInProgressPathOf } from './cache-file-names.ts';
import { cacheDirectoriesOf, cacheLayoutOf } from './cache-layout.ts';
import type { CacheLayout } from './cache-layout.ts';

const CACHE_SCHEMA_VERSION = 1;
const NOT_A_CACHE = 'is not empty and is not an cratepin cache';

/** What the marker file says, or that there is none. */
type MarkerReading =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly projectId: string | undefined };

function foreignCacheError(layout: CacheLayout, reason: string): PipelineError {
  return new PipelineError(
    'OUTPUT_CONFLICT',
    `The cache directory ${reason}; nothing was changed.`,
    {
      cacheRoot: layout.root,
    },
  );
}

/** The project ID of a well-formed version 1 marker; anything else reads as `undefined`. */
function markedProjectIdOf(text: string): string | undefined {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return undefined;
  const marker = parsed.value as { schemaVersion?: unknown; projectId?: unknown } | null;
  const isVersionOne = marker?.schemaVersion === CACHE_SCHEMA_VERSION;
  return isVersionOne && typeof marker.projectId === 'string' ? marker.projectId : undefined;
}

/** The marker names its project and schema version; a larger file is not one this tool wrote. */
const MAX_CACHE_MARKER_BYTES = 4096;

async function readMarker(layout: CacheLayout): Promise<MarkerReading> {
  try {
    const text = await readTextWithin(layout.markerFile, MAX_CACHE_MARKER_BYTES);
    const projectId = text === undefined ? undefined : markedProjectIdOf(text);
    return { status: 'present', projectId };
  } catch (error) {
    if (toPipelineError(error).code === 'NOT_FOUND') return { status: 'absent' };
    throw error;
  }
}

function assertMarkedProject(
  layout: CacheLayout,
  projectId: string,
  marked: string | undefined,
): void {
  if (marked === projectId) return;
  const reason =
    marked === undefined
      ? 'has a marker file this tool cannot read'
      : `belongs to project "${marked}"`;
  throw foreignCacheError(layout, reason);
}

/**
 * True when the root is empty apart from markers other runs are just writing: a run that creates
 * a cache links its marker before it adds anything else. Only such a directory is adopted, so
 * files of anything else are never touched.
 */
async function isEmptyApartFromMarkersInProgress(layout: CacheLayout): Promise<boolean> {
  const names = await readdir(layout.root);
  return names.every((name) => isCacheName('markerInProgress', name));
}

/** Writes the marker under a temporary name and links it into place; false if one is there. */
async function linkMarker(layout: CacheLayout, projectId: string): Promise<boolean> {
  const marker = `${JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, projectId })}\n`;
  const temporaryPath = markerInProgressPathOf(layout);
  try {
    await writeFile(temporaryPath, marker, { flag: 'wx', flush: true });
    return await linkIfAbsent(temporaryPath, layout.markerFile);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** The marker must exist and name this project. */
async function assertOwnMarker(layout: CacheLayout, projectId: string): Promise<void> {
  const reading = await readMarker(layout);
  if (reading.status === 'absent') throw foreignCacheError(layout, NOT_A_CACHE);
  assertMarkedProject(layout, projectId, reading.projectId);
}

/**
 * Marks an empty root as this project's cache, so no run ever reads a half-written marker. A
 * root that is not empty, or a marker another run linked first, must already be this project's.
 */
async function markAsOwnCache(layout: CacheLayout, projectId: string): Promise<void> {
  const isAdoptable = await isEmptyApartFromMarkersInProgress(layout);
  if (!isAdoptable || !(await linkMarker(layout, projectId))) {
    await assertOwnMarker(layout, projectId);
  }
}

/** Absent or a real directory; anything else (a file, a link) is a conflict. */
async function cacheRootKind(layout: CacheLayout): Promise<'absent' | 'directory'> {
  const kind = await entryKindAt(layout.root);
  if (kind === 'absent' || kind === 'directory') return kind;
  throw foreignCacheError(
    layout,
    kind === 'unreadable' ? 'cannot be inspected' : 'is not a directory',
  );
}

/**
 * The project's cache when it exists, for runs that only read; `undefined` when there is none
 * yet (also an empty directory, or one another run is just creating). A foreign or unmarked
 * non-empty directory is a conflict.
 */
export async function existingCache(project: CheckedProject): Promise<CacheLayout | undefined> {
  const layout = cacheLayoutOf(project.paths.cacheRoot);
  if ((await cacheRootKind(layout)) === 'absent') return undefined;
  const isUnmarked = (await readMarker(layout)).status === 'absent';
  if (isUnmarked && (await isEmptyApartFromMarkersInProgress(layout))) return undefined;
  await assertOwnMarker(layout, project.config.projectId);
  return layout;
}

/**
 * Opens the project's cache for writing after checking the layout again: creates the root and
 * its marker when absent, adopts only an empty directory, refuses another project's cache, and
 * makes sure every cache directory is a real directory.
 */
export async function prepareCache(project: CheckedProject): Promise<CacheLayout> {
  await assertLayoutStillSafe(project, 'the cache was not changed');
  const layout = cacheLayoutOf(project.paths.cacheRoot);
  const { projectId } = project.config;
  if ((await cacheRootKind(layout)) === 'absent') await mkdir(layout.root, { recursive: true });
  const reading = await readMarker(layout);
  if (reading.status === 'present') assertMarkedProject(layout, projectId, reading.projectId);
  else await markAsOwnCache(layout, projectId);
  for (const directory of cacheDirectoriesOf(layout)) await ensureDirectory(directory);
  return layout;
}
