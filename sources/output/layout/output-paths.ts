import { canonicalExtensionOf } from '../../catalog/media-types.ts';
import type { TransformPolicy } from '../../media/policies/transform-policy.ts';

/** The one name at the top of the owned output that the runtime manifest takes. */
export const RUNTIME_MANIFEST_NAME = 'cratepin-manifest.json';

/** What an output's path is made from: the original's path and media type. */
export interface OutputSource {
  readonly source: string;
  readonly mediaType: string;
}

function withExtension(path: string, extension: string): string {
  const fileStart = path.lastIndexOf('/') + 1;
  const extensionStart = path.lastIndexOf('.');
  const stem = extensionStart > fileStart ? path.slice(0, extensionStart) : path;
  return `${stem}.${extension}`;
}

/**
 * Where an output goes inside the output tree: the original's source-relative path, unchanged
 * when the output keeps the original's media type (`.PNG` stays `.PNG`), otherwise with only its
 * last extension replaced by the new type's usual one (`cat.png` becomes `cat.webp`).
 */
export function outputPathOf({ source, mediaType }: OutputSource, outputMediaType: string): string {
  if (outputMediaType === mediaType) return source;
  const extension = canonicalExtensionOf(outputMediaType);
  if (extension === undefined) throw new Error(`No extension is known for ${outputMediaType}`);
  return withExtension(source, extension);
}

/**
 * Every path an output may get, known before anything is converted: a copy or same-format profile
 * keeps the source path, a strict WebP profile always writes WebP, and a flexible one may keep
 * either. Collisions are judged on these, so they never depend on how well an image compressed.
 */
export function possibleOutputPathsOf(original: OutputSource, policy: TransformPolicy): string[] {
  if (policy.kind === 'copy' || policy.output.format === 'same') return [original.source];
  const webpPath = outputPathOf(original, 'image/webp');
  if (!policy.output.keepSmaller || webpPath === original.source) return [webpPath];
  return [original.source, webpPath];
}
