import type { AssetEntry } from '../config/pipeline-config.ts';
import { isLogicalId } from '../config/rules/asset-rules.ts';
import { caseFoldedPath } from '../paths/portable-path.ts';
import type { InventoryEntry, SourceInventory } from './inventory.ts';
import { compareCodeUnits, sortedByPath } from './ordering.ts';
import {
  accept,
  groupsSharingKey,
  issuesForGroupMembers,
  outcomeOf,
  reject,
  sourceIssue,
} from './source-issues.ts';
import type { Checked, SourceIssue } from './source-issues.ts';

/** An inventoried original with its logical ID and the metadata authored for it. */
export interface CatalogedAsset extends InventoryEntry {
  readonly id: string;
  readonly locale?: string;
  readonly role?: string;
  readonly profile?: string;
  readonly licence?: string;
}

/** Every usable original sorted by logical ID, plus the inventory's and the catalog's findings. */
export interface SourceCatalog {
  readonly assets: readonly CatalogedAsset[];
  readonly issues: readonly SourceIssue[];
}

/**
 * The logical ID a file gets without an authored `id`: its path without the last extension, so
 * converting `images/cat.png` to `images/cat.webp` keeps the ID `images/cat`. It is in NFC form,
 * even when the file name on disk is decomposed.
 */
export function derivedIdOf(path: string): string {
  const fileNameStart = path.lastIndexOf('/') + 1;
  const extensionStart = path.lastIndexOf('.');
  const withoutExtension = extensionStart > fileNameStart ? path.slice(0, extensionStart) : path;
  return withoutExtension.normalize('NFC');
}

/** `assets` fields that travel with the asset; `category` already shaped the inventory. */
const METADATA_FIELDS = ['id', 'locale', 'role', 'profile', 'licence'] as const;
type AuthoredMetadata = Partial<Pick<AssetEntry, (typeof METADATA_FIELDS)[number]>>;

function authoredMetadata(entry: AssetEntry | undefined): AuthoredMetadata {
  if (entry === undefined) return {};
  const presentFields = METADATA_FIELDS.flatMap((field) =>
    entry[field] === undefined ? [] : [[field, entry[field]]],
  );
  return Object.fromEntries(presentFields) as AuthoredMetadata;
}

function catalogEntry(
  inventoried: InventoryEntry,
  authored: AssetEntry | undefined,
): Checked<CatalogedAsset> {
  const { id = derivedIdOf(inventoried.path), ...metadata } = authoredMetadata(authored);
  if (!isLogicalId(id)) return reject(sourceIssue(inventoried.path, 'INVALID_ID'));
  return accept({ ...inventoried, id, ...metadata });
}

/** Authored entries whose source the inventory does not know: missing, renamed or not selected. */
function missingSourceIssues(
  inventory: SourceInventory,
  authored: readonly AssetEntry[],
): SourceIssue[] {
  const knownPaths = [...inventory.entries, ...inventory.issues].map((known) => known.path);
  const knownKeys = new Set(knownPaths.map(caseFoldedPath));
  return authored.flatMap((entry, index) =>
    knownKeys.has(caseFoldedPath(entry.source))
      ? []
      : [sourceIssue(`/assets/${String(index)}/source`, 'MISSING_SOURCE')],
  );
}

function duplicateIdIssues(assets: readonly CatalogedAsset[]): SourceIssue[] {
  const groups = groupsSharingKey(assets, (asset) => caseFoldedPath(asset.id));
  const pathGroups = groups.map((group) => group.map((asset) => asset.path));
  return issuesForGroupMembers(pathGroups, 'DUPLICATE_ID');
}

/**
 * Gives every inventoried original its logical ID and authored metadata. IDs come from the
 * `assets` entries or, without one, from the path; they never depend on the content hash.
 */
export function catalogSources(
  inventory: SourceInventory,
  authored: readonly AssetEntry[],
): SourceCatalog {
  const authoredBySource = new Map(authored.map((entry) => [caseFoldedPath(entry.source), entry]));
  const outcomes = inventory.entries.map((inventoried) =>
    catalogEntry(inventoried, authoredBySource.get(caseFoldedPath(inventoried.path))),
  );
  const cataloged = outcomeOf(outcomes);
  const issues = [
    ...inventory.issues,
    ...cataloged.issues,
    ...missingSourceIssues(inventory, authored),
    ...duplicateIdIssues(cataloged.accepted),
  ];
  const assets = cataloged.accepted.toSorted((left, right) => compareCodeUnits(left.id, right.id));
  return { assets, issues: sortedByPath(issues) };
}
