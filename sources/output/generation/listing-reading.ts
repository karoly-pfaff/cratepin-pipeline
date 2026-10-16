import { join } from 'node:path';

import { isJsonObject } from '../../json/strict-json.ts';
import { isPortableRelativePath } from '../../paths/portable-path.ts';
import { isSha256Hex } from '../../lock/lock-validation.ts';
import { GENERATION_LISTING_NAME } from './generation-listing.ts';
import type { ListedFile } from './generation-listing.ts';
import { MAX_TOOL_JSON_BYTES, readToolJson } from '../files/output-files.ts';

/** A listed file whose path stays inside the tree, so removing it can never reach elsewhere. */
function listedFileOf(value: unknown): ListedFile | undefined {
  if (!isJsonObject(value)) return undefined;
  const { path, sha256, bytes, mediaType } = value;
  const isFile =
    isPortableRelativePath(path) &&
    isSha256Hex(sha256) &&
    Number.isSafeInteger(bytes) &&
    typeof mediaType === 'string';
  return isFile ? { path, sha256: sha256 as string, bytes: bytes as number, mediaType } : undefined;
}

function listedFilesOf(value: unknown): ListedFile[] | undefined {
  if (!isJsonObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.files))
    return undefined;
  const files = (value.files as unknown[]).map(listedFileOf);
  return files.every((file) => file !== undefined) ? files : undefined;
}

/** A generation listing as published: its exact text and its files. */
export interface PublishedListing {
  readonly text: string;
  readonly files: readonly ListedFile[];
}

/**
 * Reads the generation listing at the top of a tree, strictly: every path must be a portable
 * relative path inside the tree. Anything else is `undefined`, so nothing is ever removed or
 * trusted on its say.
 */
export async function readGenerationListing(tree: string): Promise<PublishedListing | undefined> {
  const reading = await readToolJson(join(tree, GENERATION_LISTING_NAME), MAX_TOOL_JSON_BYTES);
  if (reading.state !== 'parsed') return undefined;
  const files = listedFilesOf(reading.value);
  return files === undefined ? undefined : { text: reading.text, files };
}
