import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { PipelineError, toPipelineError } from '../../errors.ts';

/** How often and how patiently a transient failure is retried. */
export interface RetryPolicy {
  /** Tries in total, including the first; 1 means no retry. */
  readonly attempts: number;
  /** Milliseconds to wait before retry number `retry` (1, 2, …). */
  readonly delayBeforeRetry: (retry: number) => number;
  readonly signal?: AbortSignal | undefined;
}

const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;

/** Exponential backoff with full jitter: a random wait up to 250 ms, 500 ms, 1 s, … at most 4 s. */
export function jitteredBackoff(retry: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (retry - 1));
  return randomInt(ceiling + 1);
}

type Outcome<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: PipelineError };

async function outcomeOf<Result>(operation: () => Promise<Result>): Promise<Outcome<Result>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: toPipelineError(error) };
  }
}

/** Only transient transfer failures are retried; authentication, integrity or cancellation never. */
function isWorthRetrying(error: PipelineError, attempt: number, policy: RetryPolicy): boolean {
  return error.isRetryable && attempt < policy.attempts && policy.signal?.aborted !== true;
}

/** A failure after the signal aborted is a cancellation, whatever the request reported. */
function finalFailure(error: PipelineError, policy: RetryPolicy): PipelineError {
  if (policy.signal?.aborted !== true) return error;
  return new PipelineError('CANCELLED', 'Operation was cancelled.');
}

/**
 * Runs `operation`, retrying it after transient failures up to `policy.attempts` tries in total.
 * The wait between tries ends early with CANCELLED when the signal aborts. Rejects with the last
 * failure as a PipelineError.
 */
export async function withRetries<Result>(
  operation: () => Promise<Result>,
  policy: RetryPolicy,
): Promise<Result> {
  let attempt = 1;
  let outcome = await outcomeOf(operation);
  while (!outcome.ok && isWorthRetrying(outcome.error, attempt, policy)) {
    await delay(policy.delayBeforeRetry(attempt), undefined, { signal: policy.signal }).catch(
      (error: unknown) => {
        throw toPipelineError(error);
      },
    );
    attempt += 1;
    outcome = await outcomeOf(operation);
  }
  if (outcome.ok) return outcome.value;
  throw finalFailure(outcome.error, policy);
}
