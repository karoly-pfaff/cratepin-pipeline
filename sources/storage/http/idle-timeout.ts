import { setTimeout as delay } from 'node:timers/promises';

import { PipelineError } from '../../errors.ts';

/** How long a body may stall, which object it is, and how to stop its transfer. */
export interface IdleLimit {
  readonly timeoutMs: number;
  readonly key: string;
  /** Aborts the underlying request, so a read that hangs on the stalled body ends too. */
  readonly stopTransfer: () => void;
}

function ignore(): void {
  // The losing timer of a race is cancelled on purpose; its rejection means nothing.
}

function stalledError(key: string): PipelineError {
  return new PipelineError('TRANSIENT_TRANSFER', 'The server sent no data for too long.', { key });
}

/**
 * The next chunk, or a transient failure if none arrives in time. Stopping the transfer makes
 * the hanging read fail too; whichever error comes first, a stall is reported as a stall.
 */
async function nextChunkWithin(
  chunks: AsyncIterator<Uint8Array>,
  limit: IdleLimit,
): Promise<IteratorResult<Uint8Array>> {
  const timer = new AbortController();
  const progress = { hasStalled: false };
  const stalled = delay(limit.timeoutMs, undefined, { signal: timer.signal }).then(() => {
    progress.hasStalled = true;
    limit.stopTransfer();
    throw stalledError(limit.key);
  });
  stalled.catch(ignore);
  try {
    return await Promise.race([chunks.next(), stalled]);
  } catch (error) {
    throw progress.hasStalled ? stalledError(limit.key) : error;
  } finally {
    timer.abort();
  }
}

/**
 * Streams a response body, failing if it stalls for `timeoutMs` between two chunks. Unlike a
 * deadline for the whole download, this lets a large object take as long as it needs while it
 * keeps moving. Stopping early cancels the rest of the body.
 */
export async function* withIdleTimeout(
  body: AsyncIterable<Uint8Array>,
  limit: IdleLimit,
): AsyncGenerator<Uint8Array> {
  const chunks = body[Symbol.asyncIterator]();
  try {
    let step = await nextChunkWithin(chunks, limit);
    while (step.done !== true) {
      yield step.value;
      step = await nextChunkWithin(chunks, limit);
    }
  } finally {
    await chunks.return?.().catch(ignore);
  }
}
