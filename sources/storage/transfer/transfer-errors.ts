import { PipelineError, toPipelineError } from '../../errors.ts';

/** Any failure as a PipelineError; an aborted signal always means CANCELLED, whatever its reason. */
function pipelineErrorOf(error: unknown, signal: AbortSignal | undefined): PipelineError {
  const failure = toPipelineError(error);
  if (signal?.aborted !== true) return failure;
  // Keeps what the failure knew, e.g. the ID of a multipart upload that could not be aborted.
  return new PipelineError('CANCELLED', 'Operation was cancelled.', failure.details);
}

/** Runs a storage operation so that it can only fail with a PipelineError. */
export async function withPipelineErrors<Result>(
  operation: () => Promise<Result>,
  signal: AbortSignal | undefined,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw pipelineErrorOf(error, signal);
  }
}

/** Streams the body `open` starts; opening and streaming can only fail with a PipelineError. */
export async function* streamWithPipelineErrors(
  open: () => Promise<AsyncIterable<Uint8Array>>,
  signal: AbortSignal | undefined,
): AsyncIterable<Uint8Array> {
  try {
    yield* await open();
  } catch (error) {
    throw pipelineErrorOf(error, signal);
  }
}
