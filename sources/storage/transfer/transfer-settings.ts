import { defaultConfig } from '../../config/pipeline-config.ts';
import type { ResourceLimits } from '../../config/pipeline-config.ts';
import type { R2Connection } from '../r2/r2-connection.ts';
import { jitteredBackoff } from './retries.ts';
import type { RetryPolicy } from './retries.ts';

/** How transfers are split, retried and timed, from the config's `limits`. */
export interface TransferSettings {
  /** Originals of at least this size are uploaded in parts of `multipartPartBytes`. */
  readonly multipartThresholdBytes: number;
  readonly multipartPartBytes: number;
  /** Parts uploaded at the same time; memory holds at most this many parts plus one. */
  readonly partConcurrency: number;
  /** Tries per request for transient failures, including the first. */
  readonly transferAttempts: number;
  readonly requestTimeoutMs: number;
  readonly delayBeforeRetry: (retry: number) => number;
}

/** A connection with the settings its transfers follow. */
export interface R2Transfer {
  readonly connection: R2Connection;
  readonly settings: TransferSettings;
}

export function transferSettingsFrom(
  limits: ResourceLimits,
  concurrency: number = limits.concurrency,
): TransferSettings {
  return {
    multipartThresholdBytes: limits.multipartThresholdBytes,
    multipartPartBytes: limits.multipartPartBytes,
    partConcurrency: concurrency,
    transferAttempts: limits.transferAttempts,
    requestTimeoutMs: limits.requestTimeoutSeconds * 1000,
    delayBeforeRetry: jitteredBackoff,
  };
}

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = transferSettingsFrom(
  defaultConfig().limits,
);

export function retryPolicyOf(
  settings: TransferSettings,
  signal: AbortSignal | undefined,
): RetryPolicy {
  return {
    attempts: settings.transferAttempts,
    delayBeforeRetry: settings.delayBeforeRetry,
    signal,
  };
}
