import { join } from 'node:path';

import {
  generationLayoutOf,
  GENERATIONS_DIRECTORY,
} from '../output/generation/generation-layout.ts';
import {
  GENERATION_LISTING_NAME,
  generationDigestOf,
  generationNameOf,
} from '../output/generation/generation-listing.ts';
import type { ListedFile } from '../output/generation/generation-listing.ts';
import type { PublishedListing } from '../output/generation/listing-reading.ts';
import { readGenerationListing } from '../output/generation/listing-reading.ts';
import { hasContentOf } from '../output/files/content-sniff.ts';
import type { ToolFile } from '../output/files/output-files.ts';
import { OUTPUT_MARKER_NAME, outputMarkerTextOf } from '../output/ownership/output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from '../output/layout/output-paths.ts';
import { auditOutputTree } from '../output/files/tree-audit.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import type { ReportIssue } from '../report.ts';
import type { ParsedManifest } from './published-manifest.ts';

/** Where the files a manifest describes are published, and the tool files beside them. */
export interface PublishedTree {
  readonly directory: string;
  /** The tree's place below the output root: `""` or `generations/<name>/`. */
  readonly prefix: string;
  /** The tool files in the tree besides its listing. */
  readonly toolFiles: readonly ToolFile[];
}

/** The tree a manifest describes: the root itself, or the generation it names. */
export function publishedTreeOf(
  project: CheckedProject,
  manifest: ParsedManifest,
  manifestText: string,
): PublishedTree {
  const root = project.paths.outputRoot;
  if (manifest.header.outputMode === 'path-preserving') {
    const toolFiles = [
      { name: OUTPUT_MARKER_NAME, text: outputMarkerTextOf(project.config) },
      { name: RUNTIME_MANIFEST_NAME, text: manifestText },
    ];
    return { directory: root, prefix: '', toolFiles };
  }
  const name = generationNameOf(manifest.header.generation);
  const directory = join(generationLayoutOf(root).generations, name);
  return { directory, prefix: `${GENERATIONS_DIRECTORY}/${name}/`, toolFiles: [] };
}

/** A MANIFEST_INVALID issue: the manifest or a listing is not what the tool writes. */
export function manifestInvalid(path: string, message: string): ReportIssue {
  return { path, code: 'MANIFEST_INVALID', message };
}

/**
 * Reads the tree's listing, which must be readable and digest to the generation the manifest
 * names; the listing when readable, and the issues.
 */
export async function readNamedListing(
  directory: string,
  generation: string,
): Promise<{ readonly listing?: PublishedListing; readonly issues: readonly ReportIssue[] }> {
  const listing = await readGenerationListing(directory);
  const listingPath = join(directory, GENERATION_LISTING_NAME);
  if (listing === undefined) {
    return {
      issues: [manifestInvalid(listingPath, 'The generation listing is missing or damaged.')],
    };
  }
  const isNamed = generationDigestOf(listing.text) === generation;
  const issues = isNamed
    ? []
    : [manifestInvalid(listingPath, 'The listing is not the generation the manifest names.')];
  return { listing, issues };
}

/** Listed files whose content is not of the type their name says, among those not yet found. */
async function contentIssuesOf(
  tree: PublishedTree,
  files: readonly ListedFile[],
): Promise<ReportIssue[]> {
  const issues: ReportIssue[] = [];
  for (const file of files) {
    const path = join(tree.directory, ...file.path.split('/'));
    if (!(await hasContentOf(path, file.mediaType))) {
      issues.push({
        path: file.path,
        code: 'OUTPUT_MISMATCH',
        message: `The content is not ${file.mediaType}.`,
      });
    }
  }
  return issues;
}

/**
 * Audits a published tree against its listing: exactly the listed files and tool files, every
 * byte hashed, no link or other entry, and each image's content of the type its name says.
 * Findings carry their path below the output root.
 */
export async function treeIssuesOf(
  tree: PublishedTree,
  listing: PublishedListing,
): Promise<ReportIssue[]> {
  const toolFiles = [...tree.toolFiles, { name: GENERATION_LISTING_NAME, text: listing.text }];
  const findings = await auditOutputTree(tree.directory, { files: listing.files, toolFiles });
  const found = new Set(findings.map(({ path }) => path));
  const unfound = listing.files.filter(({ path }) => !found.has(path));
  const issues = [...findings, ...(await contentIssuesOf(tree, unfound))];
  return issues.map((issue) => ({ ...issue, path: tree.prefix + issue.path }));
}
