import { DEFAULT_RESIZE_FIT, DEFAULT_WEBP_ENCODING, defaultConfig } from './pipeline-config.ts';
import type {
  MediaProfile,
  PipelineConfig,
  R2Settings,
  ResizeBox,
  ResourceLimits,
  SourceSelection,
  WebpEncoding,
} from './pipeline-config.ts';
import type { RawConfigObject } from './rules/field-rules.ts';
import { derivedOutputUrlPath } from './rules/output-url-rules.ts';

/** Only `undefined` means "absent"; every other value was already judged by the shape rules. */
function valueOrDefault<Value>(value: unknown, fallback: Value): Value {
  return value === undefined ? fallback : (value as Value);
}

function fieldsOf(value: unknown): RawConfigObject {
  return (value === undefined ? {} : value) as RawConfigObject;
}

function normalizeSources(raw: unknown, defaults: SourceSelection): SourceSelection {
  const sources = fieldsOf(raw);
  return {
    include: valueOrDefault(sources.include, defaults.include),
    categories: valueOrDefault(sources.categories, defaults.categories),
  };
}

function normalizeR2(raw: unknown, defaults: R2Settings): R2Settings {
  const r2 = fieldsOf(raw);
  return {
    endpointEnv: valueOrDefault(r2.endpointEnv, defaults.endpointEnv),
    bucketEnv: valueOrDefault(r2.bucketEnv, defaults.bucketEnv),
    writer: valueOrDefault(r2.writer, defaults.writer),
    read: valueOrDefault(r2.read, defaults.read),
  };
}

function normalizeResize(raw: RawConfigObject): ResizeBox {
  return {
    width: raw.width as number,
    height: raw.height as number,
    fit: valueOrDefault(raw.fit, DEFAULT_RESIZE_FIT),
  };
}

function normalizeWebp(raw: RawConfigObject): WebpEncoding {
  return {
    lossless: valueOrDefault(raw.lossless, DEFAULT_WEBP_ENCODING.lossless),
    quality: valueOrDefault(raw.quality, DEFAULT_WEBP_ENCODING.quality),
    alphaQuality: valueOrDefault(raw.alphaQuality, DEFAULT_WEBP_ENCODING.alphaQuality),
    keepSmaller: valueOrDefault(raw.keepSmaller, DEFAULT_WEBP_ENCODING.keepSmaller),
  };
}

function normalizeProfile(raw: RawConfigObject): MediaProfile {
  if (raw.kind === 'copy') return { kind: 'copy' };
  return {
    kind: 'image',
    ...(raw.resize === undefined ? {} : { resize: normalizeResize(fieldsOf(raw.resize)) }),
    ...(raw.webp === undefined ? {} : { webp: normalizeWebp(fieldsOf(raw.webp)) }),
  };
}

function normalizeProfiles(raw: unknown): Readonly<Record<string, MediaProfile>> {
  const entries = Object.entries(fieldsOf(raw));
  return Object.fromEntries(
    entries.map(([name, profile]) => [name, normalizeProfile(fieldsOf(profile))]),
  );
}

function normalizeLimits(raw: unknown, defaults: ResourceLimits): ResourceLimits {
  const limits = fieldsOf(raw);
  return {
    concurrency: valueOrDefault(limits.concurrency, defaults.concurrency),
    imageConcurrency: valueOrDefault(limits.imageConcurrency, defaults.imageConcurrency),
    maxSourceBytes: valueOrDefault(limits.maxSourceBytes, defaults.maxSourceBytes),
    maxImagePixels: valueOrDefault(limits.maxImagePixels, defaults.maxImagePixels),
    multipartThresholdBytes: valueOrDefault(
      limits.multipartThresholdBytes,
      defaults.multipartThresholdBytes,
    ),
    multipartPartBytes: valueOrDefault(limits.multipartPartBytes, defaults.multipartPartBytes),
    transferAttempts: valueOrDefault(limits.transferAttempts, defaults.transferAttempts),
    requestTimeoutSeconds: valueOrDefault(
      limits.requestTimeoutSeconds,
      defaults.requestTimeoutSeconds,
    ),
  };
}

/**
 * Turns a shape-valid raw config into a PipelineConfig with every default filled in. An explicit
 * `0`, `false` or empty string is kept as given; only absent fields take defaults.
 */
export function normalizeConfig(raw: RawConfigObject): PipelineConfig {
  const defaults = defaultConfig();
  const outputDir = valueOrDefault(raw.outputDir, defaults.outputDir);
  return {
    schemaVersion: 1,
    projectId: raw.projectId as string,
    sourceDir: valueOrDefault(raw.sourceDir, defaults.sourceDir),
    cacheDir: valueOrDefault(raw.cacheDir, defaults.cacheDir),
    lockFile: valueOrDefault(raw.lockFile, defaults.lockFile),
    outputDir,
    outputMode: valueOrDefault(raw.outputMode, defaults.outputMode),
    outputUrlPath: valueOrDefault(raw.outputUrlPath, derivedOutputUrlPath(outputDir) ?? ''),
    objectPrefix: valueOrDefault(raw.objectPrefix, defaults.objectPrefix),
    sources: normalizeSources(raw.sources, defaults.sources),
    r2: normalizeR2(raw.r2, defaults.r2),
    profiles: normalizeProfiles(raw.profiles),
    profileRules: valueOrDefault(raw.profileRules, defaults.profileRules),
    defaultProfile: valueOrDefault(raw.defaultProfile, defaults.defaultProfile),
    assets: valueOrDefault(raw.assets, defaults.assets),
    limits: normalizeLimits(raw.limits, defaults.limits),
  };
}
