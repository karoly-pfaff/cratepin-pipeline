import { randomUUID } from 'node:crypto';
import { lstat, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { linkIfAbsent } from '../../paths/files/create-only-files.ts';
import { isMarkerInProgress, OUTPUT_MARKER_NAME, outputMarkerTextOf } from './output-marker.ts';
import type { OutputOwner } from './output-marker.ts';

/**
 * Writes the root's marker under a temporary name, flushed, and links it into place, so no
 * reader ever sees half a marker. False when a marker was already there.
 */
export async function linkOutputMarker(root: string, owner: OutputOwner): Promise<boolean> {
  const temporary = join(root, `${OUTPUT_MARKER_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, outputMarkerTextOf(owner), { flag: 'wx', flush: true });
    return await linkIfAbsent(temporary, join(root, OUTPUT_MARKER_NAME));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Removes markers a crashed run left half-written: regular files of that name only, never links. */
export async function removeMarkersInProgress(root: string): Promise<void> {
  for (const name of (await readdir(root)).filter(isMarkerInProgress)) {
    const path = join(root, name);
    if ((await lstat(path)).isFile()) await rm(path, { force: true });
  }
}
