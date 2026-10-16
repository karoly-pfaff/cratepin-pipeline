import { join, toNamespacedPath } from 'node:path';

import sharp from 'sharp';

import type { ListedFile } from '../output/generation/generation-listing.ts';
import type { ManifestEntry } from '../output/manifest/runtime-manifest.ts';
import type { ReportIssue } from '../report.ts';
import type { PublishedTree } from './published-tree.ts';

import '../media/encoding/sharp-settings.ts';

/** A byte-audited publication and the listed file matched to each manifest entry. */
interface DimensionCheck {
  readonly tree: PublishedTree;
  readonly entries: readonly ManifestEntry[];
  readonly filesById: ReadonlyMap<string, ListedFile>;
}

function dimensionIssue(id: string, message: string): ReportIssue {
  return { path: id, code: 'MANIFEST_MISMATCH', message: `dimensions: ${message}` };
}

/** Metadata avoids pixel allocation; the native reader needs Windows' extended long-path form. */
async function imageHeaderIssues(entry: ManifestEntry, path: string): Promise<ReportIssue[]> {
  try {
    const header = await sharp(toNamespacedPath(path), { limitInputPixels: false }).metadata();
    const { width, height } = entry.asset;
    return header.width === width && header.height === height
      ? []
      : [
          dimensionIssue(
            entry.id,
            `the entry says ${String(width)} by ${String(height)}, the published header is ${String(header.width)} by ${String(header.height)}`,
          ),
        ];
  } catch {
    return [dimensionIssue(entry.id, 'the published image header cannot be read.')];
  }
}

async function entryDimensionIssues(
  entry: ManifestEntry,
  check: DimensionCheck,
): Promise<ReportIssue[]> {
  const file = check.filesById.get(entry.id);
  if (entry.asset.width === undefined || file === undefined) return [];
  if (file.mediaType !== 'image/png' && file.mediaType !== 'image/webp') {
    return [dimensionIssue(entry.id, 'only PNG or WebP entries can declare dimensions.')];
  }
  return imageHeaderIssues(entry, join(check.tree.directory, ...file.path.split('/')));
}

/** Checks declared sizes only after the tree has passed its byte, type and regular-file audit. */
export async function imageDimensionIssues(check: DimensionCheck): Promise<ReportIssue[]> {
  const issues: ReportIssue[] = [];
  for (const entry of check.entries) issues.push(...(await entryDimensionIssues(entry, check)));
  return issues;
}
