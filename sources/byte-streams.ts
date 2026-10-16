import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';

import { PipelineError, throwIfCancelled } from './errors.ts';

export function* sliceIntoChunks(content: Uint8Array, chunkBytes: number): Generator<Uint8Array> {
  for (let offset = 0; offset < content.length; offset += chunkBytes) {
    yield content.slice(offset, offset + chunkBytes);
  }
}

/** Streams chunks like a network source: one event-loop turn per chunk, so aborts are observed. */
export async function* streamChunksUntilCancelled(
  chunks: Iterable<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await nextEventLoopTurn();
    throwIfCancelled(signal);
    yield chunk;
  }
}

function settledByRace(): void {
  // The cancellation promise is always consumed through Promise.race; this only marks it handled.
}

interface Cancellation {
  /** Rejects with CANCELLED as soon as the signal aborts; never settles without a signal. */
  readonly cancelled: Promise<never>;
  readonly signal: AbortSignal | undefined;
  readonly stopListening: () => void;
}

function cancellationOf(signal: AbortSignal | undefined): Cancellation {
  let rejectAsCancelled!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAsCancelled = () => {
      reject(new PipelineError('CANCELLED', 'Operation was cancelled.'));
    };
  });
  cancelled.catch(settledByRace);
  if (signal?.aborted) rejectAsCancelled();
  signal?.addEventListener('abort', rejectAsCancelled, { once: true });
  return {
    cancelled,
    signal,
    stopListening: () => {
      signal?.removeEventListener('abort', rejectAsCancelled);
    },
  };
}

/** A stalled producer may close later; its cleanup failure must not replace cancellation. */
function requestIteratorClose<Chunk>(iterator: AsyncIterator<Chunk>): void {
  void Promise.resolve()
    .then(() => iterator.return?.())
    .catch(settledByRace);
}

/** Cancels even a pending source read; asks an abandoned iterator to close without awaiting it. */
export async function* chunksUntilCancelled<Chunk>(
  body: AsyncIterable<Chunk>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Chunk> {
  const iterator = body[Symbol.asyncIterator]();
  try {
    yield* cancellableChunks(iterator, signal);
  } finally {
    requestIteratorClose(iterator);
  }
}

async function* cancellableChunks<Chunk>(
  iterator: AsyncIterator<Chunk>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Chunk> {
  let step = await nextUnlessCancelled(iterator, signal);
  while (step.done !== true) {
    throwIfCancelled(signal);
    yield step.value;
    step = await nextUnlessCancelled(iterator, signal);
  }
  throwIfCancelled(signal);
}

/** A per-read race releases its result; one shared pending promise would retain every chunk. */
async function nextUnlessCancelled<Chunk>(
  iterator: AsyncIterator<Chunk>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<Chunk>> {
  const cancellation = cancellationOf(signal);
  try {
    throwIfCancelled(signal);
    return await Promise.race([iterator.next(), cancellation.cancelled]);
  } finally {
    cancellation.stopListening();
  }
}

/**
 * Reads a whole body into memory, failing with CANCELLED the moment `signal` aborts, even while
 * the body itself is stalled. On early stop the body is asked to close; an async generator that
 * is stalled inside an `await` closes only once that await settles.
 */
export async function collectUntilCancelled(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const iterator = body[Symbol.asyncIterator]();
  const cancellation = cancellationOf(signal);
  try {
    return Buffer.concat(await readChunksUntilCancelled(iterator, cancellation));
  } catch (error) {
    // Not awaited: a stalled body would keep its pending read and block the cancellation.
    requestIteratorClose(iterator);
    throw error;
  } finally {
    cancellation.stopListening();
  }
}

async function readChunksUntilCancelled(
  iterator: AsyncIterator<Uint8Array>,
  cancellation: Cancellation,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let step = await Promise.race([iterator.next(), cancellation.cancelled]);
  while (step.done !== true) {
    chunks.push(step.value);
    step = await Promise.race([iterator.next(), cancellation.cancelled]);
  }
  // An abort right after the last chunk still cancels: nothing may be stored afterwards.
  throwIfCancelled(cancellation.signal);
  return chunks;
}
