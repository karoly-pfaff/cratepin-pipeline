import { basename, dirname, join } from 'node:path';

/**
 * The hidden directory next to an output root, e.g. `public/.assets.cratepin` for
 * `public/assets`: builds of both modes keep their claims there, and a path-preserving build
 * stages the next root, keeps the previous one during a swap and removes old ones there. Builds
 * move and remove files under its names, so no source, cache or project file may live in it.
 */
export function outputWorkDirectoryOf(outputRoot: string): string {
  return join(dirname(outputRoot), `.${basename(outputRoot)}.cratepin`);
}

/** A name of the form `.<name>.cratepin`: the work directory of some output root. */
const WORK_DIRECTORY_NAME = /^\..+\.cratepin$/iu;

/**
 * Whether a path is, or lies in, a directory named like a work directory: its own output root's
 * or that of a sibling root another config publishes into.
 */
export function hasWorkDirectorySegment(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => WORK_DIRECTORY_NAME.test(segment));
}
