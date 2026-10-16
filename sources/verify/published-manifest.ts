import { MEDIA_CATEGORIES } from '../config/pipeline-config.ts';
import { RUNTIME_MANIFEST_SCHEMA_VERSION } from '../contracts.ts';
import type { ManifestAsset } from '../contracts.ts';
import { isJsonObject } from '../json/strict-json.ts';
import { isSha256Hex } from '../lock/lock-validation.ts';
import { manifestTextOf } from '../output/manifest/runtime-manifest.ts';
import type { ManifestEntry, ManifestHeader } from '../output/manifest/runtime-manifest.ts';

type Fields = Readonly<Record<string, unknown>>;

/** A runtime manifest as the tool writes it: its header and every entry. */
export interface ParsedManifest {
  readonly header: ManifestHeader;
  readonly entries: readonly ManifestEntry[];
}

const ASSET_FIELDS: ReadonlySet<string> = new Set([
  'url',
  'mediaType',
  'bytes',
  'sha256',
  'width',
  'height',
  'category',
  'role',
  'locale',
  'source',
  'sourceSha256',
]);
const HEADER_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'projectId',
  'outputMode',
  'generation',
  'assets',
]);

function hasOnlyFields(value: Fields, known: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => known.has(key));
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDimension(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function hasAssetTypes(fields: Fields): boolean {
  const { url, mediaType, bytes, sha256, category, source, sourceSha256 } = fields;
  const texts = [url, mediaType, source].every((text) => typeof text === 'string');
  const isCategory = (MEDIA_CATEGORIES as readonly unknown[]).includes(category);
  return texts && isCategory && isCount(bytes) && isSha256Hex(sha256) && isSha256Hex(sourceSha256);
}

function hasOptionalAssetTypes({ width, height, role, locale }: Fields): boolean {
  const isSize =
    width === undefined ? height === undefined : isDimension(width) && isDimension(height);
  return isSize && isOptionalText(role) && isOptionalText(locale);
}

function assetOf(value: unknown): ManifestAsset | undefined {
  if (!isJsonObject(value) || !hasOnlyFields(value, ASSET_FIELDS)) return undefined;
  if (!hasAssetTypes(value) || !hasOptionalAssetTypes(value)) return undefined;
  return value as unknown as ManifestAsset;
}

function entriesOf(assets: Fields): ManifestEntry[] | undefined {
  const entries: ManifestEntry[] = [];
  for (const [id, value] of Object.entries(assets)) {
    const asset = assetOf(value);
    if (asset === undefined) return undefined;
    entries.push({ id, asset });
  }
  return entries;
}

function headerOf(value: Fields): ManifestHeader | undefined {
  const { schemaVersion, projectId, outputMode, generation } = value;
  const isHeader =
    schemaVersion === RUNTIME_MANIFEST_SCHEMA_VERSION &&
    typeof projectId === 'string' &&
    (outputMode === 'path-preserving' || outputMode === 'generation') &&
    isSha256Hex(generation);
  return isHeader
    ? { projectId, outputMode: outputMode, generation: generation as string }
    : undefined;
}

/** The header and entries of a value with only the manifest's fields, in their types. */
function manifestFieldsOf(value: unknown): ParsedManifest | undefined {
  if (!isJsonObject(value) || !hasOnlyFields(value, HEADER_FIELDS)) return undefined;
  const header = headerOf(value);
  const entries = isJsonObject(value.assets) ? entriesOf(value.assets) : undefined;
  return header === undefined || entries === undefined ? undefined : { header, entries };
}

/**
 * The manifest a strictly parsed value and its text are, only when it is exactly what the tool
 * writes: the known header and asset fields with their types, nothing else, and the text the
 * tool would write for them byte for byte (sorted IDs, field order, spacing, final newline).
 * Anything else is `undefined`: the manifest is damaged, edited by hand or not this tool's.
 */
export function parsePublishedManifest(value: unknown, text: string): ParsedManifest | undefined {
  const parsed = manifestFieldsOf(value);
  if (parsed === undefined) return undefined;
  return manifestTextOf(parsed.header, parsed.entries) === text ? parsed : undefined;
}
