import type { ListedFile } from '../output/generation/generation-listing.ts';
import { outputUrlOf } from '../output/layout/output-urls.ts';
import type { ManifestEntry } from '../output/manifest/runtime-manifest.ts';
import type { ReportIssue } from '../report.ts';

/** The published entries and the files they must describe. */
export interface EntryCheck {
  readonly entries: readonly ManifestEntry[];
  readonly files: readonly ListedFile[];
  readonly outputUrlPath: string;
  /** Where the listed files sit below the output root: `""` or `generations/<name>/`. */
  readonly prefix: string;
}

/** What the entries said: the issues, and the listed file each entry describes, by ID. */
export interface EntryMatch {
  readonly issues: readonly ReportIssue[];
  readonly filesById: ReadonlyMap<string, ListedFile>;
}

function mismatch(path: string, field: string, message: string): ReportIssue {
  return { path, code: 'MANIFEST_MISMATCH', message: `${field}: ${message}` };
}

const DESCRIBED_FIELDS = ['sha256', 'bytes', 'mediaType'] as const;

function fieldIssues({ id, asset }: ManifestEntry, file: ListedFile): ReportIssue[] {
  return DESCRIBED_FIELDS.filter((field) => asset[field] !== file[field]).map((field) =>
    mismatch(
      id,
      field,
      `the entry says ${String(asset[field])}, the published file is ${String(file[field])}`,
    ),
  );
}

function unreferencedIssues(files: readonly ListedFile[], referenced: ReadonlyMap<string, number>) {
  return files
    .filter(({ path }) => referenced.get(path) !== 1)
    .map(({ path }) =>
      mismatch(
        path,
        'entries',
        `${String(referenced.get(path) ?? 0)} manifest entries name this published file; exactly one must`,
      ),
    );
}

/** How many entries name each listed file, by its path. */
function referenceCountsOf(filesById: ReadonlyMap<string, ListedFile>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { path } of filesById.values()) counts.set(path, (counts.get(path) ?? 0) + 1);
  return counts;
}

/**
 * Checks every manifest entry against the published files: its URL must be the configured URL
 * path and a listed file's encoded path, and its hash, size and media type that file's; every
 * listed file is named by exactly one entry. Mismatches are MANIFEST_MISMATCH, by ID or path.
 */
export function matchEntriesToFiles(check: EntryCheck): EntryMatch {
  const filesByUrl = new Map(
    check.files.map((file) => [outputUrlOf(check.outputUrlPath, check.prefix + file.path), file]),
  );
  const matched = check.entries.map((entry) => ({ entry, file: filesByUrl.get(entry.asset.url) }));
  const filesById = new Map<string, ListedFile>();
  for (const { entry, file } of matched) if (file !== undefined) filesById.set(entry.id, file);
  const issues = matched.flatMap(({ entry, file }) =>
    file === undefined
      ? [mismatch(entry.id, 'url', 'names no published file')]
      : fieldIssues(entry, file),
  );
  return {
    issues: [...issues, ...unreferencedIssues(check.files, referenceCountsOf(filesById))],
    filesById,
  };
}
