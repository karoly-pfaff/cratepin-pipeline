import { createHash } from 'node:crypto';

import { compareCodeUnits } from '../../catalog/ordering.ts';

/** The hidden file in a generation that lists exactly what the tool wrote there. */
export const GENERATION_LISTING_NAME = '.cratepin-generation.json';

const GENERATION_LISTING_SCHEMA_VERSION = 1;

/** Hex characters of the generation digest that name a generation directory. */
export const GENERATION_NAME_LENGTH = 16;

/** One output file as written: its path inside the generation and its exact bytes. */
export interface ListedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
}

/**
 * The listing's text: its files by path in code-unit order, nothing else (no project, URL, time
 * or machine), so the same outputs give the same text in either output mode and in any project.
 */
export function listingTextOf(files: readonly ListedFile[]): string {
  const sorted = files
    .map(({ path, sha256, bytes, mediaType }) => ({ path, sha256, bytes, mediaType }))
    .toSorted((left, right) => compareCodeUnits(left.path, right.path));
  const listing = { schemaVersion: GENERATION_LISTING_SCHEMA_VERSION, files: sorted };
  return `${JSON.stringify(listing, null, 2)}\n`;
}

/** The generation digest: the SHA-256 of the listing text, covering every output path and byte. */
export function generationDigestOf(listingText: string): string {
  return createHash('sha256').update(listingText).digest('hex');
}

/** A generation directory's name: the first `length` hex characters of its digest. */
export function generationNameOf(digest: string, length = GENERATION_NAME_LENGTH): string {
  return digest.slice(0, length);
}
