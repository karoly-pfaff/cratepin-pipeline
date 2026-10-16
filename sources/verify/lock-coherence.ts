import type { BuildPlan, PlannedAsset } from '../building/planning/build-plan.ts';
import type { SourceLock, SourceRecord } from '../lock/source-lock.ts';
import { COPY_ONLY_ROLES } from '../media/policies/special-media.ts';
import type { ListedFile } from '../output/generation/generation-listing.ts';
import type { ManifestEntry } from '../output/manifest/runtime-manifest.ts';
import type { ReportIssue } from '../report.ts';

/** The published entries, the files they describe and what the committed lock and config plan. */
export interface CoherenceCheck {
  readonly entries: readonly ManifestEntry[];
  readonly filesById: ReadonlyMap<string, ListedFile>;
  readonly plan: BuildPlan;
  readonly lock: SourceLock;
}

function stale(path: string, message: string): ReportIssue {
  return { path, code: 'MANIFEST_STALE', message: `${message}; build again.` };
}

const PROVENANCE_FIELDS = ['source', 'sourceSha256', 'category', 'role', 'locale'] as const;

type Provenance = Readonly<Record<(typeof PROVENANCE_FIELDS)[number], string | undefined>>;

/** The provenance fields an entry copies from its lock record, as the record has them. */
function provenanceOf(record: SourceRecord): Provenance {
  return {
    source: record.source,
    sourceSha256: record.sha256,
    category: record.category,
    role: record.role,
    locale: record.locale,
  };
}

function provenanceIssues({ id, asset }: ManifestEntry, record: SourceRecord): ReportIssue[] {
  const locked = provenanceOf(record);
  return PROVENANCE_FIELDS.filter((field) => asset[field] !== locked[field]).map((field) =>
    stale(id, `${field} is not the locked one`),
  );
}

function isCopy({ record, profile }: PlannedAsset): boolean {
  return profile.policy.kind === 'copy' || COPY_ONLY_ROLES.has(record.role ?? '');
}

/** One published entry with what the lock plans for it and the file it describes. */
interface PlannedEntry {
  readonly entry: ManifestEntry;
  readonly planned: PlannedAsset;
  readonly file: ListedFile | undefined;
}

function pathIssues({ entry, planned, file }: PlannedEntry): ReportIssue[] {
  if (file === undefined || planned.possiblePaths.includes(file.path)) return [];
  const paths = planned.possiblePaths.join(' or ');
  return [stale(entry.id, `profile "${planned.profile.name}" gives ${paths}, not ${file.path}`)];
}

function copyIssues({ entry, planned }: PlannedEntry): ReportIssue[] {
  const { sha256, bytes } = entry.asset;
  const isExactCopy = sha256 === planned.record.sha256 && bytes === planned.record.bytes;
  return isCopy(planned) && !isExactCopy
    ? [stale(entry.id, 'a copy must hold the original bytes exactly')]
    : [];
}

function entryIssues(plannedEntry: PlannedEntry): ReportIssue[] {
  return [
    ...provenanceIssues(plannedEntry.entry, plannedEntry.planned.record),
    ...pathIssues(plannedEntry),
    ...copyIssues(plannedEntry),
  ];
}

/**
 * Checks the published manifest against the committed lock and the config: exactly the locked
 * IDs, each entry with its record's source, hash, category, role and locale, at a path its
 * current profile can give it, and a copy (also every print master) with the original's exact
 * bytes. Anything else is MANIFEST_STALE: the output was built from another lock or config. A
 * locked asset the plan cannot place (an undefined profile) is reported by the plan itself.
 * Encoder options a profile changes without changing paths are not visible here; only a new
 * build applies them.
 */
export function lockCoherenceIssues(check: CoherenceCheck): ReportIssue[] {
  const plannedById = new Map(check.plan.assets.map((planned) => [planned.record.id, planned]));
  const lockedIds = new Set(check.lock.assets.map(({ id }) => id));
  const publishedIds = new Set(check.entries.map(({ id }) => id));
  const unpublished = [...plannedById.keys()]
    .filter((id) => !publishedIds.has(id))
    .map((id) => stale(id, 'locked but not published'));
  const published = check.entries.flatMap((entry) => {
    const planned = plannedById.get(entry.id);
    if (planned !== undefined) {
      return entryIssues({ entry, planned, file: check.filesById.get(entry.id) });
    }
    return lockedIds.has(entry.id) ? [] : [stale(entry.id, 'published but not locked')];
  });
  return [...unpublished, ...published];
}
