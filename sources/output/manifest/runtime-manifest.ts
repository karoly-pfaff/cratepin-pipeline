import { compareCodeUnits } from '../../catalog/ordering.ts';
import type { OutputMode } from '../../config/pipeline-config.ts';
import { RUNTIME_MANIFEST_SCHEMA_VERSION } from '../../contracts.ts';
import type { ManifestAsset } from '../../contracts.ts';

/** What the manifest says about the whole output. */
export interface ManifestHeader {
  readonly projectId: string;
  readonly outputMode: OutputMode;
  readonly generation: string;
}

/** One asset's manifest entry under its logical ID. */
export interface ManifestEntry {
  readonly id: string;
  readonly asset: ManifestAsset;
}

/** The asset's fields in their documented order, optional ones only when set. */
function orderedAsset(asset: ManifestAsset): ManifestAsset {
  const { width, height, role, locale } = asset;
  return {
    url: asset.url,
    mediaType: asset.mediaType,
    bytes: asset.bytes,
    sha256: asset.sha256,
    ...(width === undefined || height === undefined ? {} : { width, height }),
    category: asset.category,
    ...(role === undefined ? {} : { role }),
    ...(locale === undefined ? {} : { locale }),
    source: asset.source,
    sourceSha256: asset.sourceSha256,
  };
}

function entryText({ id, asset }: ManifestEntry): string {
  const assetText = JSON.stringify(orderedAsset(asset), null, 2).replaceAll('\n', '\n    ');
  return `    ${JSON.stringify(id)}: ${assetText}`;
}

/**
 * The manifest's exact text: two-space JSON with a final newline and the assets in code-unit
 * order of their IDs. Written entry by entry, because `JSON.stringify` of an object puts
 * integer-like keys such as `10` first, whatever order they were added in.
 */
export function manifestTextOf(header: ManifestHeader, entries: readonly ManifestEntry[]): string {
  const sorted = entries.toSorted((left, right) => compareCodeUnits(left.id, right.id));
  const assetsText = sorted.length === 0 ? '{}' : `{\n${sorted.map(entryText).join(',\n')}\n  }`;
  const headerFields = [
    `  "schemaVersion": ${String(RUNTIME_MANIFEST_SCHEMA_VERSION)}`,
    `  "projectId": ${JSON.stringify(header.projectId)}`,
    `  "outputMode": ${JSON.stringify(header.outputMode)}`,
    `  "generation": ${JSON.stringify(header.generation)}`,
  ];
  return `{\n${headerFields.join(',\n')},\n  "assets": ${assetsText}\n}\n`;
}
