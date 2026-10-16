import { join } from 'node:path';

import { isJsonObject } from '../../json/strict-json.ts';
import { MAX_TOOL_JSON_BYTES, readToolJson } from '../files/output-files.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';

/** What a published manifest says about one asset that a change shows in. */
interface PublishedAsset {
  readonly url: string;
  readonly sha256: string;
}

/** The published manifest's assets by logical ID, or why there are none to compare with. */
export type PublishedManifest =
  | { readonly state: 'present'; readonly assets: ReadonlyMap<string, PublishedAsset> }
  | { readonly state: 'absent' | 'unreadable' };

function publishedAssetOf(value: unknown): PublishedAsset | undefined {
  if (!isJsonObject(value)) return undefined;
  const { url, sha256 } = value;
  return typeof url === 'string' && typeof sha256 === 'string' ? { url, sha256 } : undefined;
}

/** The assets of a parsed runtime manifest, or `undefined` when it is not one the tool wrote. */
export function publishedAssetsOf(value: unknown): Map<string, PublishedAsset> | undefined {
  if (!isJsonObject(value) || !isJsonObject(value.assets)) return undefined;
  const assets = new Map<string, PublishedAsset>();
  for (const [id, entry] of Object.entries(value.assets)) {
    const asset = publishedAssetOf(entry);
    if (asset === undefined) return undefined;
    assets.set(id, asset);
  }
  return assets;
}

/**
 * Reads the runtime manifest at the top of an output root, strictly (a duplicated field makes it
 * unreadable), to compare a new build with it. Reads only.
 */
export async function readPublishedManifest(root: string): Promise<PublishedManifest> {
  const reading = await readToolJson(join(root, RUNTIME_MANIFEST_NAME), MAX_TOOL_JSON_BYTES);
  if (reading.state !== 'parsed') return { state: reading.state };
  const assets = publishedAssetsOf(reading.value);
  return assets === undefined ? { state: 'unreadable' } : { state: 'present', assets };
}
