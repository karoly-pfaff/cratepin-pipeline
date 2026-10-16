import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { GENERATION_NAME_LENGTH, generationNameOf } from './generation-listing.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';

/** In generation mode, the directory of the output root that holds one directory per generation. */
export const GENERATIONS_DIRECTORY = 'generations';

const STAGING_NAME = '.staging';
const TRASH_NAME = '.trash';
const MANIFEST_IN_PROGRESS_NAME = `.${RUNTIME_MANIFEST_NAME}.tmp`;

/**
 * Where a generation-mode output lives, all inside its owned root (it never moves): the runtime
 * manifest at the top is the publication point, written first under a temporary name; every
 * generation is `generations/<name>/`, immutable once renamed into place; the next one is staged
 * in `generations/.staging/` and old ones are removed through `generations/.trash/<uuid>/`.
 */
export interface GenerationLayout {
  readonly root: string;
  readonly manifest: string;
  readonly manifestInProgress: string;
  readonly generations: string;
  readonly staging: string;
  readonly trash: string;
}

export function generationLayoutOf(outputRoot: string): GenerationLayout {
  const generations = join(outputRoot, GENERATIONS_DIRECTORY);
  return {
    root: outputRoot,
    manifest: join(outputRoot, RUNTIME_MANIFEST_NAME),
    manifestInProgress: join(outputRoot, MANIFEST_IN_PROGRESS_NAME),
    generations,
    staging: join(generations, STAGING_NAME),
    trash: join(generations, TRASH_NAME),
  };
}

/** The directory of the generation with this digest. */
export function generationDirectoryOf(layout: GenerationLayout, digest: string): string {
  return join(layout.generations, generationNameOf(digest));
}

const GENERATION_NAME_PATTERN = new RegExp(`^[0-9a-f]{${String(GENERATION_NAME_LENGTH)}}$`, 'u');

/** Whether a name in `generations/` is one the tool gives a generation directory. */
export function isGenerationName(name: string): boolean {
  return GENERATION_NAME_PATTERN.test(name);
}

/** Names the tool itself uses in `generations/` besides the generations. */
export function isGenerationWorkName(name: string): boolean {
  return name === STAGING_NAME || name === TRASH_NAME;
}

/** Names the tool itself uses at the top of a generation-mode root, besides its marker. */
export function isGenerationRootName(name: string): boolean {
  return [RUNTIME_MANIFEST_NAME, MANIFEST_IN_PROGRESS_NAME, GENERATIONS_DIRECTORY].includes(name);
}

/** A new, unique place in the trash for one old generation or a directory holding its name. */
export function generationTrashPathOf(layout: GenerationLayout): string {
  return join(layout.trash, randomUUID());
}
