/** Normalized configuration: every optional field of cratepin.config.json has its default. */

/** Allowed values as tuples, so validation and types share one source of truth. */
export const OUTPUT_MODES = ['path-preserving', 'generation'] as const;
export const MEDIA_CATEGORIES = ['image', 'voice', 'effects', 'music', 'other'] as const;
export const RESIZE_FITS = ['contain', 'inside'] as const;
export const MAX_CONCURRENCY = 64;
export const MAX_IMAGE_CONCURRENCY = 16;

export type OutputMode = (typeof OUTPUT_MODES)[number];
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];
export type ResizeFit = (typeof RESIZE_FITS)[number];

export interface CategoryRule {
  readonly match: string;
  readonly category: MediaCategory;
}

export interface SourceSelection {
  readonly include: readonly string[];
  readonly categories: readonly CategoryRule[];
}

export interface CredentialEnvNames {
  readonly accessKeyIdEnv: string;
  readonly secretAccessKeyEnv: string;
}

export type ReadTransport =
  | { readonly transport: 'public-http'; readonly publicBaseUrl: string }
  | ({ readonly transport: 's3-readonly' } & CredentialEnvNames);

export interface R2Settings {
  readonly endpointEnv: string;
  readonly bucketEnv: string;
  readonly writer: CredentialEnvNames;
  readonly read: ReadTransport;
}

export interface ResizeBox {
  readonly width: number;
  readonly height: number;
  readonly fit: ResizeFit;
}

export interface WebpEncoding {
  readonly lossless: boolean;
  readonly quality: number;
  readonly alphaQuality: number;
  readonly keepSmaller: boolean;
}

export type MediaProfile =
  | { readonly kind: 'copy' }
  | { readonly kind: 'image'; readonly resize?: ResizeBox; readonly webp?: WebpEncoding };

export interface ProfileRule {
  readonly match: string;
  readonly profile: string;
}

/**
 * Authored metadata for one source file, kept apart from its hash. Every field except `source`
 * is optional: `id` replaces the logical ID derived from the path, `category` and `profile`
 * replace the rule-based choice.
 */
export interface AssetEntry {
  readonly source: string;
  readonly id?: string;
  readonly category?: MediaCategory;
  readonly locale?: string;
  readonly role?: string;
  readonly profile?: string;
  readonly licence?: string;
}

export interface ResourceLimits {
  readonly concurrency: number;
  /** Image conversions at once, each holding its original, decoded pixels and output in memory. */
  readonly imageConcurrency: number;
  readonly maxSourceBytes: number;
  readonly maxImagePixels: number;
  /** Originals of at least this size are uploaded in parts. */
  readonly multipartThresholdBytes: number;
  readonly multipartPartBytes: number;
  /** Tries per request for transient failures, including the first. */
  readonly transferAttempts: number;
  readonly requestTimeoutSeconds: number;
}

export interface PipelineConfig {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly sourceDir: string;
  readonly cacheDir: string;
  readonly lockFile: string;
  readonly outputDir: string;
  readonly outputMode: OutputMode;
  /**
   * The URL path at which `outputDir` is served, relative to the host's public root and without
   * slashes at either end; manifest URLs start with it. `""` when `outputDir` is the public root's
   * content itself.
   */
  readonly outputUrlPath: string;
  readonly objectPrefix: string;
  readonly sources: SourceSelection;
  readonly r2: R2Settings;
  readonly profiles: Readonly<Record<string, MediaProfile>>;
  readonly profileRules: readonly ProfileRule[];
  readonly defaultProfile: string;
  readonly assets: readonly AssetEntry[];
  readonly limits: ResourceLimits;
}

export interface ConfigIssue {
  readonly path: string;
  readonly code: 'CONFIG_INVALID' | 'CONFIG_SECRET';
  readonly message: string;
}

export type ConfigValidation =
  | { readonly ok: true; readonly config: PipelineConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;
export const BUILT_IN_COPY_PROFILE = 'copy';

const IMAGE_EXTENSIONS = '{png,gif,svg,webp,jpg,jpeg}';

export const DEFAULT_WEBP_ENCODING: WebpEncoding = {
  lossless: true,
  quality: 80,
  alphaQuality: 100,
  keepSmaller: true,
};
export const DEFAULT_RESIZE_FIT: ResizeFit = 'contain';

const DEFAULT_CONFIG: PipelineConfig = {
  schemaVersion: 1,
  projectId: 'example-game',
  sourceDir: 'assets/source',
  cacheDir: '.cratepin-cache',
  lockFile: 'cratepin-lock.json',
  outputDir: 'public/assets',
  outputMode: 'path-preserving',
  outputUrlPath: 'assets',
  objectPrefix: 'cratepin/v1',
  sources: {
    include: [`**/*.${IMAGE_EXTENSIONS}`, '**/*.{mp3,ogg,wav,m4a}'],
    categories: [
      { match: '**/voice/**', category: 'voice' },
      { match: '**/effects/**', category: 'effects' },
      { match: '**/music/**', category: 'music' },
      { match: `**/*.${IMAGE_EXTENSIONS}`, category: 'image' },
    ],
  },
  r2: {
    endpointEnv: 'R2_ENDPOINT',
    bucketEnv: 'R2_BUCKET',
    writer: {
      accessKeyIdEnv: 'R2_WRITE_ACCESS_KEY_ID',
      secretAccessKeyEnv: 'R2_WRITE_SECRET_ACCESS_KEY',
    },
    read: {
      transport: 's3-readonly',
      accessKeyIdEnv: 'R2_READ_ACCESS_KEY_ID',
      secretAccessKeyEnv: 'R2_READ_SECRET_ACCESS_KEY',
    },
  },
  profiles: {},
  profileRules: [],
  defaultProfile: BUILT_IN_COPY_PROFILE,
  assets: [],
  limits: {
    concurrency: 4,
    imageConcurrency: 2,
    maxSourceBytes: 512 * 1024 * 1024,
    // About 3 GiB for one worst-case conversion (lossless WebP of noise, ~45 bytes per pixel).
    maxImagePixels: 8192 * 8192,
    multipartThresholdBytes: 64 * 1024 * 1024,
    multipartPartBytes: 16 * 1024 * 1024,
    transferAttempts: 3,
    requestTimeoutSeconds: 300,
  },
};

/** The profile called `name`: the built-in copy profile or a configured one, never an inherited key. */
export function findProfile(config: PipelineConfig, name: string): MediaProfile | undefined {
  if (name === BUILT_IN_COPY_PROFILE) return { kind: 'copy' };
  return Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
}

export function defaultConfig(): PipelineConfig {
  return structuredClone(DEFAULT_CONFIG);
}
