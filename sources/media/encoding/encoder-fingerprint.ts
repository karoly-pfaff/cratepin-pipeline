import sharp from 'sharp';

/**
 * Raised whenever this tool changes how it turns an original into output bytes, so every
 * derivative made before is recomputed instead of reused.
 */
const TRANSFORM_VERSION = 1;

/**
 * Everything besides the policy that decides the bytes of a derivative: this tool's transform
 * version, the Sharp and libvips versions and those of the libraries libvips uses for PNG, WebP,
 * colour management and compression, and the platform and CPU architecture. Identical output is
 * only promised within one fingerprint. With Sharp's prebuilt binaries every version is known;
 * a libvips installed elsewhere may not report them, and they read `unknown`.
 */
export interface EncoderFingerprint {
  readonly transformVersion: number;
  readonly sharp: string;
  readonly libvips: string;
  readonly libwebp: string;
  /** `libpng <version>` or `libspng <version>`, whichever reads PNG. */
  readonly pngLibrary: string;
  readonly lcms: string;
  readonly zlib: string;
  readonly platform: string;
  readonly arch: string;
}

function pngLibraryOf(versions: typeof sharp.versions): string {
  if (versions.png !== undefined) return `libpng ${versions.png}`;
  return versions.spng === undefined ? 'unknown' : `libspng ${versions.spng}`;
}

/** The fingerprint of the encoder this process actually loaded. */
export function encoderFingerprint(): EncoderFingerprint {
  const { versions } = sharp;
  const zlib = (versions as Readonly<Record<string, string | undefined>>)['zlib-ng'];
  return {
    transformVersion: TRANSFORM_VERSION,
    sharp: versions.sharp,
    libvips: versions.vips,
    libwebp: versions.webp ?? 'unknown',
    pngLibrary: pngLibraryOf(versions),
    lcms: versions.lcms ?? 'unknown',
    zlib: zlib ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
  };
}
