import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';

import type { PipelineError } from '../../errors.ts';

/** The SHA-256 and length a body must have. */
export interface ExpectedContent {
  readonly sha256: string;
  readonly bytes: number;
}

/** Counts and hashes the chunks it is shown, failing as soon as there are too many bytes. */
class ContentCheck {
  private readonly hasher: Hash = createHash('sha256');
  private readonly expected: ExpectedContent;
  private readonly mismatch: () => PipelineError;
  private bytes = 0;

  constructor(expected: ExpectedContent, mismatch: () => PipelineError) {
    this.expected = expected;
    this.mismatch = mismatch;
  }

  add(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    if (this.bytes > this.expected.bytes) throw this.mismatch();
    this.hasher.update(chunk);
  }

  assertComplete(): void {
    const isExpected = this.bytes === this.expected.bytes;
    if (!isExpected || this.hasher.digest('hex') !== this.expected.sha256) throw this.mismatch();
  }
}

/** Owns each nonempty chunk before hashing: a producer may reuse its buffer after yielding. */
async function* nonEmptyCopies(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    if (chunk.length > 0) yield Uint8Array.from(chunk);
  }
}

/**
 * Passes the chunks through while proving they have the expected SHA-256 and length. The last
 * chunk is held back until everything was hashed, so a receiver never gets all expected bytes
 * of wrong content: a single request ends short and fails, a multipart upload fails before its
 * completion. Fails with `mismatch()` as soon as there are too many bytes or at the end.
 */
export async function* withContentCheck(
  chunks: AsyncIterable<Uint8Array>,
  expected: ExpectedContent,
  mismatch: () => PipelineError,
): AsyncGenerator<Uint8Array> {
  const check = new ContentCheck(expected, mismatch);
  let heldBack: Uint8Array | undefined;
  for await (const chunk of nonEmptyCopies(chunks)) {
    check.add(chunk);
    if (heldBack !== undefined) yield heldBack;
    heldBack = chunk;
  }
  check.assertComplete();
  if (heldBack !== undefined) yield heldBack;
}
