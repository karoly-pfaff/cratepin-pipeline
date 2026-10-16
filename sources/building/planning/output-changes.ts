import { compareCodeUnits } from '../../catalog/ordering.ts';
import type { PublishedManifest } from '../../output/manifest/manifest-reading.ts';
import { extensionOf } from '../../catalog/media-types.ts';
import type { SourceRecord } from '../../lock/source-lock.ts';
import type { BuiltAsset } from '../assembly/asset-outputs.ts';
import type { PlannedAsset } from './build-plan.ts';
import type { AssembledOutput } from '../assembly/output-assembly.ts';

/** How a build's assets differ from the published manifest, by logical ID. */
export interface OutputChanges {
  readonly addedIds: readonly string[];
  readonly removedIds: readonly string[];
  /** Known outputs whose bytes (or, once every output is known, URL) differ from the published. */
  readonly changedIds: readonly string[];
}

/** An output published under another extension than its original's. */
export interface ExtensionChange {
  readonly id: string;
  readonly source: string;
  readonly outputPath: string;
  readonly fromExtension: string;
  readonly toExtension: string;
}

/** An asset's original and the output path it will certainly get. */
export interface CertainOutput {
  readonly record: Pick<SourceRecord, 'id' | 'source'>;
  readonly outputPath: string;
}

/**
 * The output paths already certain: a known output's, or the only path a profile can give (a
 * copy, a same-format profile or strict WebP). A flexible WebP profile not yet converted may keep
 * either path, so it is not certain.
 */
export function certainOutputsOf(
  assets: readonly PlannedAsset[],
  known: readonly BuiltAsset[],
): CertainOutput[] {
  const knownById = new Map(known.map((built) => [built.record.id, built]));
  return assets.flatMap(({ record, possiblePaths }) => {
    const outputPath = knownById.get(record.id)?.outputPath ?? possiblePaths[0];
    const isCertain = knownById.has(record.id) || possiblePaths.length === 1;
    return isCertain && outputPath !== undefined ? [{ record, outputPath }] : [];
  });
}

/** Every certain output whose path is not its source path: hosts must look these up by ID. */
export function extensionChangesOf(outputs: readonly CertainOutput[]): ExtensionChange[] {
  return outputs
    .filter(({ record, outputPath }) => record.source !== outputPath)
    .map(({ record, outputPath }) => ({
      id: record.id,
      source: record.source,
      outputPath,
      fromExtension: extensionOf(record.source),
      toExtension: extensionOf(outputPath),
    }))
    .toSorted((left, right) => compareCodeUnits(left.id, right.id));
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].toSorted(compareCodeUnits);
}

/** URLs by ID, known only once every output is: in generation mode a URL names the generation. */
function newUrlsOf(assembled: AssembledOutput | undefined): ReadonlyMap<string, string> {
  return new Map((assembled?.entries ?? []).map(({ id, asset }) => [id, asset.url]));
}

/**
 * Compares the IDs the lock pins and the outputs already known with the published manifest:
 * IDs added and removed, and known outputs whose bytes or URL differ. Nothing is reported as
 * changed when there is no readable published manifest to compare with.
 */
export function outputChangesOf(
  lockIds: readonly string[],
  built: readonly BuiltAsset[],
  context: { readonly published: PublishedManifest; readonly assembled?: AssembledOutput },
): OutputChanges {
  const { published, assembled } = context;
  if (published.state !== 'present')
    return { addedIds: sorted(lockIds), removedIds: [], changedIds: [] };
  const ids = new Set(lockIds);
  const urls = newUrlsOf(assembled);
  const changedIds = built.flatMap(({ record, conversion }) => {
    const before = published.assets.get(record.id);
    const url = urls.get(record.id);
    const isChanged =
      before !== undefined &&
      (before.sha256 !== conversion.outputSha256 || (url !== undefined && url !== before.url));
    return isChanged ? [record.id] : [];
  });
  return {
    addedIds: sorted(lockIds.filter((id) => !published.assets.has(id))),
    removedIds: sorted([...published.assets.keys()].filter((id) => !ids.has(id))),
    changedIds: sorted(changedIds),
  };
}
