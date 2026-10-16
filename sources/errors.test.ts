import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineError, toPipelineError } from './errors.ts';
import type { ErrorCode } from './errors.ts';

const EXPECTED_EXIT_CODE_AND_RETRYABILITY: Readonly<Record<ErrorCode, readonly [number, boolean]>> =
  {
    IO_FAILED: [1, false],
    CONFIG_INVALID: [2, false],
    NOT_IMPLEMENTED: [3, false],
    USAGE: [4, false],
    AUTH_FAILED: [5, false],
    TRANSIENT_TRANSFER: [6, true],
    INTEGRITY_MISMATCH: [7, false],
    INVALID_DATA: [8, false],
    OUTPUT_CONFLICT: [9, false],
    NOT_FOUND: [10, false],
    CANCELLED: [130, false],
  };

function errorWithSystemCode(code: string): Error {
  return Object.assign(new Error(`raw ${code} /home/me/secret`), { code });
}

function errorNamed(name: string): Error {
  return Object.assign(new Error('raw message'), { name });
}

test('every error code keeps its exit code and only transient transfer is retryable', () => {
  for (const [code, expected] of Object.entries(EXPECTED_EXIT_CODE_AND_RETRYABILITY)) {
    const failure = new PipelineError(code as ErrorCode, code);
    assert.deepEqual([failure.exitCode, failure.isRetryable], expected, code);
  }
});

test('thrown values are classified without leaking their raw message', () => {
  const classifications: readonly (readonly [unknown, ErrorCode])[] = [
    [errorNamed('AbortError'), 'CANCELLED'],
    [errorNamed('TimeoutError'), 'TRANSIENT_TRANSFER'],
    [errorWithSystemCode('ENOENT'), 'NOT_FOUND'],
    [errorWithSystemCode('EEXIST'), 'OUTPUT_CONFLICT'],
    [errorWithSystemCode('ECONNRESET'), 'TRANSIENT_TRANSFER'],
    [
      new TypeError('fetch failed', { cause: errorWithSystemCode('UND_ERR_SOCKET') }),
      'TRANSIENT_TRANSFER',
    ],
    [errorWithSystemCode('constructor'), 'IO_FAILED'],
    [null, 'IO_FAILED'],
    ['plain text with a secret', 'IO_FAILED'],
  ];
  for (const [thrown, expectedCode] of classifications) {
    const converted = toPipelineError(thrown);
    assert.equal(converted.code, expectedCode, String(thrown));
    assert.doesNotMatch(converted.message, /secret|home/);
  }
});

test('a PipelineError passes through conversion unchanged', () => {
  const integrityFailure = new PipelineError('INTEGRITY_MISMATCH', 'bytes differ', { key: 'k' });
  assert.equal(toPipelineError(integrityFailure), integrityFailure);
});

test('a PipelineError wrapped as the cause of another error passes unchanged', () => {
  const inner = new PipelineError('INTEGRITY_MISMATCH', 'The source file changed.');
  assert.equal(toPipelineError(new TypeError('fetch failed', { cause: inner })), inner);
});
