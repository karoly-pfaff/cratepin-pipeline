import type { PipelineConfig } from '../../config/pipeline-config.ts';
import type { ManifestAsset } from '../../contracts.ts';
import {
  GENERATION_LISTING_NAME,
  generationDigestOf,
  generationNameOf,
  listingTextOf,
} from '../../output/generation/generation-listing.ts';
import { GENERATIONS_DIRECTORY } from '../../output/generation/generation-layout.ts';
import type { ListedFile } from '../../output/generation/generation-listing.ts';
import { outputUrlOf } from '../../output/layout/output-urls.ts';
import { manifestTextOf } from '../../output/manifest/runtime-manifest.ts';
import type { ManifestEntry } from '../../output/manifest/runtime-manifest.ts';
import type { BuiltAsset } from './asset-outputs.ts';

/** The settings that shape the manifest. */
export type ManifestSettings = Pick<PipelineConfig, 'projectId' | 'outputMode' | 'outputUrlPath'>;

/** The complete, deterministic description of one build's output. */
export interface AssembledOutput {
  /** Every output file, by its path inside the output tree (or the generation). */
  readonly files: readonly ListedFile[];
  readonly listingText: string;
  /** Where the listing goes below the output root: in generation mode inside its generation. */
  readonly listingPath: string;
  /** The generation digest: SHA-256 of the listing text. */
  readonly generation: string;
  readonly entries: readonly ManifestEntry[];
  readonly manifestText: string;
}

function listedFileOf({ outputPath, conversion }: BuiltAsset): ListedFile {
  const { outputSha256, outputBytes, mediaType } = conversion;
  return { path: outputPath, sha256: outputSha256, bytes: outputBytes, mediaType };
}

function manifestAssetOf(built: BuiltAsset, url: string): ManifestAsset {
  const { record, conversion } = built;
  const { role, locale } = record;
  return {
    url,
    mediaType: conversion.mediaType,
    bytes: conversion.outputBytes,
    sha256: conversion.outputSha256,
    ...(conversion.dimensions ?? {}),
    category: record.category,
    ...(role === undefined ? {} : { role }),
    ...(locale === undefined ? {} : { locale }),
    source: record.source,
    sourceSha256: record.sha256,
  };
}

/** Where outputs sit below the output root: the root itself, or their generation's directory. */
function treePrefixOf(settings: ManifestSettings, generation: string): string {
  if (settings.outputMode === 'path-preserving') return '';
  return `${GENERATIONS_DIRECTORY}/${generationNameOf(generation)}/`;
}

/**
 * Lists the built outputs, digests the listing into the generation, and writes the runtime
 * manifest: every asset under its logical ID with its URL (the configured URL path, then the
 * output's path, inside its generation in generation mode), real bytes, media type and
 * provenance. The same outputs always give the same texts.
 */
export function assembleOutput(
  settings: ManifestSettings,
  built: readonly BuiltAsset[],
): AssembledOutput {
  const files = built.map(listedFileOf);
  const listingText = listingTextOf(files);
  const generation = generationDigestOf(listingText);
  const prefix = treePrefixOf(settings, generation);
  const entries = built.map((asset) => ({
    id: asset.record.id,
    asset: manifestAssetOf(asset, outputUrlOf(settings.outputUrlPath, prefix + asset.outputPath)),
  }));
  const { projectId, outputMode } = settings;
  const manifestText = manifestTextOf({ projectId, outputMode, generation }, entries);
  return {
    files,
    listingText,
    listingPath: `${prefix}${GENERATION_LISTING_NAME}`,
    generation,
    entries,
    manifestText,
  };
}
