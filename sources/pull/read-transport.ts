import type { BlobReader } from '../blob-store.ts';
import type { PipelineConfig } from '../config/pipeline-config.ts';
import { createPublicHttpBlobReader } from '../storage/http/public-http-reader.ts';
import { createR2BlobReader } from '../storage/r2/r2-blob-store.ts';
import { resolveR2Connection } from '../storage/r2/r2-connection.ts';
import type { RunEnvironment } from '../storage/r2/r2-connection.ts';
import { transferSettingsFrom } from '../storage/transfer/transfer-settings.ts';

/**
 * The configured build-side read transport (ADR-007): anonymous HTTPS for `public-http`, which
 * resolves no credential at all, or the read-only key pair for `s3-readonly`, resolved only now.
 * Never the writer pair.
 */
export function openReadTransport(
  config: PipelineConfig,
  environment: RunEnvironment,
  concurrency: number,
): BlobReader {
  const settings = transferSettingsFrom(config.limits, concurrency);
  const { read } = config.r2;
  if (read.transport === 'public-http') {
    return createPublicHttpBlobReader(new URL(read.publicBaseUrl), settings);
  }
  return createR2BlobReader(resolveR2Connection(config.r2, 'read', environment), settings);
}
