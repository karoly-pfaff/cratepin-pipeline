import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { PipelineError } from '../../errors.ts';
import { withContentCheck } from './checked-body.ts';

async function* chunksOf(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield await Promise.resolve(chunk);
}

function mismatch(): PipelineError {
  return new PipelineError('INTEGRITY_MISMATCH', 'mismatch');
}

/** The bytes passed on before the check failed. */
async function bytesPassedOn(
  chunks: AsyncIterable<Uint8Array>,
  expectedText: string,
): Promise<number> {
  const expected = Buffer.from(expectedText);
  const sha256 = createHash('sha256').update(expected).digest('hex');
  let passedOn = 0;
  try {
    for await (const chunk of withContentCheck(
      chunks,
      { sha256, bytes: expected.length },
      mismatch,
    )) {
      passedOn += chunk.length;
    }
  } catch {
    return passedOn;
  }
  throw new Error('expected the check to fail');
}

test('a wrong body ending with an empty chunk still never passes on all its bytes', async () => {
  const wrong = Buffer.from('WRONG BYTES');
  assert.equal(await bytesPassedOn(chunksOf(wrong, new Uint8Array(0)), 'right bytes'), 0);
});

test('a matching body passes through unchanged, empty chunks dropped', async () => {
  const expected = Buffer.from('right bytes');
  const sha256 = createHash('sha256').update(expected).digest('hex');
  const passed: Buffer[] = [];
  const body = chunksOf(expected.subarray(0, 5), new Uint8Array(0), expected.subarray(5));
  for await (const chunk of withContentCheck(body, { sha256, bytes: expected.length }, mismatch)) {
    passed.push(Buffer.from(chunk));
  }
  assert.deepEqual(Buffer.concat(passed), expected);
  assert.equal(passed.length, 2);
});

test('a producer can reuse its buffer without changing bytes already hashed', async () => {
  const expected = Buffer.from('abcdxy');
  const sha256 = createHash('sha256').update(expected).digest('hex');
  async function* reusedBuffer(): AsyncGenerator<Uint8Array> {
    const buffer = Buffer.from('abcd');
    yield await Promise.resolve(buffer);
    buffer.write('WXYZ');
    yield await Promise.resolve(Buffer.from('xy'));
  }
  const received: Buffer[] = [];
  for await (const chunk of withContentCheck(reusedBuffer(), { sha256, bytes: 6 }, mismatch)) {
    received.push(Buffer.from(chunk));
  }
  assert.deepEqual(Buffer.concat(received), expected);
});
