/**
 * Runtime lookup of generated assets for a host page. The asset manifest maps logical IDs to URLs
 * relative to the site base, so every URL here is resolved against that base and never from a
 * leading slash: the same build then resolves its assets at a domain root, under a subpath and
 * under an app origin such as Capacitor's.
 */

/** Where the manifest is served below the site base: the config's `outputUrlPath`, then its name. */
export const DEFAULT_MANIFEST_PATH = 'assets/cratepin-manifest.json';

/**
 * The site's base URL: the host's base (Vite's `import.meta.env.BASE_URL`, `./` for a relative
 * base) read against the page address (`document.baseURI`).
 */
export function siteBaseUrl(hostBase, pageUrl) {
  return new URL(hostBase, pageUrl);
}

/** Every manifest entry as logical ID → absolute URL, resolved against `siteBase`. */
export function assetUrlsOf(manifest, siteBase) {
  return new Map(
    Object.entries(manifest.assets).map(([id, entry]) => [id, new URL(entry.url, siteBase)]),
  );
}

/** Fetches the manifest below `siteBase` and maps every logical ID to its absolute URL. */
export async function loadAssetUrls(siteBase, manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifestUrl = new URL(manifestPath, siteBase);
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Cannot load ${manifestUrl.href}: HTTP ${response.status}`);
  return assetUrlsOf(await response.json(), siteBase);
}

/** The URL of the asset `id`; an ID the manifest does not have is a host bug, not a 404. */
export function assetUrlOf(assetUrls, id) {
  const url = assetUrls.get(id);
  if (url === undefined) throw new Error(`The asset manifest has no asset "${id}"`);
  return url;
}
