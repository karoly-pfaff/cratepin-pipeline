import { PipelineError } from '../errors.ts';
import { openSourceFile } from '../paths/files/source-file-opening.ts';
import { withContentCheck } from '../storage/transfer/checked-body.ts';
import type { ExpectedContent } from '../storage/transfer/checked-body.ts';

function sourceChangedError(path: string): PipelineError {
  return new PipelineError(
    'INTEGRITY_MISMATCH',
    'The source file changed since it was scanned; scan again before pushing.',
    { path },
  );
}

/**
 * Streams a source file for upload while proving it still has the scanned bytes: the last chunk
 * is held back until the whole file matched (see `withContentCheck`), so a changed file can
 * never be stored under the old hash. Each call opens the file once (a retry calls again) and
 * sends only bytes it hashed.
 */
export async function* verifiedSourceBody(
  path: string,
  expected: ExpectedContent,
): AsyncGenerator<Uint8Array> {
  const file = await openSourceFile(path);
  try {
    const chunks = file.createReadStream({ autoClose: false, start: 0 }) as AsyncIterable<Buffer>;
    yield* withContentCheck(chunks, expected, () => sourceChangedError(path));
  } finally {
    await file.close();
  }
}
