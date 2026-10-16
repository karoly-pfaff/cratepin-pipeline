import type { MediaCategory, OutputMode } from './config/pipeline-config.ts';

/** The runtime manifest's schema version; it changes independently of the lock's. */
export const RUNTIME_MANIFEST_SCHEMA_VERSION = 1;

/**
 * One asset as a game loads it: where it is, what its bytes are, and which original it came from.
 * Only local, relative facts: never an endpoint, credential, signed URL, cache or absolute path.
 */
export interface ManifestAsset {
  /** Relative to the host's public root, never starting with `/`; resolve it with the base URL. */
  readonly url: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Present for a converted image; a copy is never decoded. */
  readonly width?: number;
  readonly height?: number;
  readonly category: MediaCategory;
  readonly role?: string;
  readonly locale?: string;
  /** The original's path relative to the source directory, e.g. to map a legacy `.png` reference. */
  readonly source: string;
  readonly sourceSha256: string;
}

/**
 * The runtime manifest at the top of the owned output, `cratepin-manifest.json`: every asset by its
 * logical ID, in code-unit order. Look entries up with `Object.hasOwn` or a `Map`, and ignore
 * fields a later version may add.
 */
export interface RuntimeManifest {
  readonly schemaVersion: typeof RUNTIME_MANIFEST_SCHEMA_VERSION;
  readonly projectId: string;
  readonly outputMode: OutputMode;
  /** SHA-256 of the generation listing: changes exactly when any output path or byte changes. */
  readonly generation: string;
  readonly assets: Readonly<Record<string, ManifestAsset>>;
}
