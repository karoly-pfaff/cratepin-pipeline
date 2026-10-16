import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BuildFixture } from '../building/build-fixtures.test-support.ts';
import { compareCodeUnits } from '../catalog/ordering.ts';
import {
  GENERATION_LISTING_NAME,
  generationDigestOf,
  listingTextOf,
} from '../output/generation/generation-listing.ts';
import { readGenerationListing } from '../output/generation/listing-reading.ts';
import { outputUrlOf } from '../output/layout/output-urls.ts';
import { RUNTIME_MANIFEST_NAME } from '../output/layout/output-paths.ts';
import { manifestTextOf } from '../output/manifest/runtime-manifest.ts';
import type { ManifestEntry } from '../output/manifest/runtime-manifest.ts';
import { parsePublishedManifest } from './published-manifest.ts';
import type { ParsedManifest } from './published-manifest.ts';
import { verifyOutput } from './output-verification.ts';
import type { Verification } from './output-verification.ts';

/** Verifies the fixture's published output against its lock. */
export function verifyFixture(fixture: BuildFixture): Promise<Verification> {
  return verifyOutput({ project: fixture.project, lock: fixture.lock });
}

/** The codes of a verification's issues, sorted, each once. */
export function issueCodesOf(verification: Verification): string[] {
  return [...new Set(verification.issues.map(({ code }) => code))].toSorted(compareCodeUnits);
}

/** One published file replaced: its new path, bytes and media type. */
export interface Replacement {
  readonly from: string;
  readonly to: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

function replacedEntry(
  entry: ManifestEntry,
  replacement: Replacement,
  urls: { readonly from: string; readonly to: string },
): ManifestEntry {
  if (entry.asset.url !== urls.from) return entry;
  const sha256 = createHash('sha256').update(replacement.bytes).digest('hex');
  const asset = {
    ...entry.asset,
    url: urls.to,
    sha256,
    bytes: replacement.bytes.length,
    mediaType: replacement.mediaType,
  };
  return { id: entry.id, asset };
}

/**
 * Rewrites a path-preserving output as if a build had published `replacement` in place of one
 * file: the file, its listing line and its manifest entry all agree, and the generation is the
 * new listing's. Only what verify compares with the lock, the config and the bytes can tell.
 */
export async function republish(fixture: BuildFixture, replacement: Replacement): Promise<void> {
  const root = fixture.project.paths.outputRoot;
  const listing = await readGenerationListing(root);
  const manifestText = await readFile(join(root, RUNTIME_MANIFEST_NAME), 'utf8');
  const manifest = parsePublishedManifest(JSON.parse(manifestText), manifestText);
  if (listing === undefined || manifest === undefined) throw new Error('Nothing to republish');
  await rm(join(root, ...replacement.from.split('/')));
  await writeFile(join(root, ...replacement.to.split('/')), replacement.bytes);
  const sha256 = createHash('sha256').update(replacement.bytes).digest('hex');
  const files = listing.files.map((file) =>
    file.path === replacement.from
      ? {
          path: replacement.to,
          sha256,
          bytes: replacement.bytes.length,
          mediaType: replacement.mediaType,
        }
      : file,
  );
  const listingText = listingTextOf(files);
  const outputUrlPath = fixture.project.config.outputUrlPath;
  const urls = {
    from: outputUrlOf(outputUrlPath, replacement.from),
    to: outputUrlOf(outputUrlPath, replacement.to),
  };
  const entries = manifest.entries.map((entry) => replacedEntry(entry, replacement, urls));
  await writeFile(join(root, GENERATION_LISTING_NAME), listingText);
  const header = { ...manifest.header, generation: generationDigestOf(listingText) };
  await writeFile(join(root, RUNTIME_MANIFEST_NAME), manifestTextOf(header, entries));
}

/** Rewrites the published manifest canonically, as `change` makes it; nothing else changes. */
export async function rewriteManifest(
  fixture: BuildFixture,
  change: (manifest: ParsedManifest) => ParsedManifest,
): Promise<void> {
  const manifestFile = join(fixture.project.paths.outputRoot, RUNTIME_MANIFEST_NAME);
  const text = await readFile(manifestFile, 'utf8');
  const manifest = parsePublishedManifest(JSON.parse(text), text);
  if (manifest === undefined) throw new Error('The published manifest is not canonical');
  const changed = change(manifest);
  await writeFile(manifestFile, manifestTextOf(changed.header, changed.entries));
}

/** The issues of one code, as `<path>: <message>`. */
export function issuesWithCode(verification: Verification, code: string): string[] {
  return verification.issues
    .filter((issue) => issue.code === code)
    .map(({ path, message }) => `${path}: ${message}`);
}
