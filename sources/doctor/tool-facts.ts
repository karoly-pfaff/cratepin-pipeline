import { readFile } from 'node:fs/promises';

import { encoderFingerprint } from '../media/encoding/encoder-fingerprint.ts';
import { libvipsThreadsPerImage } from '../media/encoding/sharp-settings.ts';
import type { ReportFacts } from '../report.ts';

/** The package manifest, two levels up from this module both in `sources/` and in `build/`. */
const PACKAGE_MANIFEST = new URL('../../package.json', import.meta.url);

async function toolVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(PACKAGE_MANIFEST, 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}

/** The tool, runtime and encoder this process runs; none of it depends on the project. */
export async function toolFacts(): Promise<ReportFacts> {
  const encoder = encoderFingerprint();
  return {
    toolVersion: await toolVersion(),
    nodeVersion: process.versions.node,
    platform: encoder.platform,
    arch: encoder.arch,
    sharp: encoder.sharp,
    libvips: encoder.libvips,
    libwebp: encoder.libwebp,
    libvipsThreadsPerImage: libvipsThreadsPerImage(),
  };
}
