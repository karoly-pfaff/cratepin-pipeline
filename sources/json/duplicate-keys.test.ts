import assert from 'node:assert/strict';
import test from 'node:test';

import { duplicateKeyPaths } from './duplicate-keys.ts';

const R2_ACCESS_KEY_ID_SHAPE = '0123456789abcdef0123456789abcdef';

test('a key repeated in the same object is reported at its path', () => {
  assert.deepEqual(duplicateKeyPaths('{"r2":{"bucketEnv":"x"},"r2":{}}'), ['/r2']);
  assert.deepEqual(duplicateKeyPaths('{"c":{"d":{"d":1,"d":2}}}'), ['/c/d/d']);
});

test('array items and sibling objects keep separate key sets', () => {
  assert.deepEqual(duplicateKeyPaths('{"a":[{"k":1,"k":2},{"k":3}],"b":{"k":4}}'), ['/a/0/k']);
});

test('quotes, braces and commas inside strings do not confuse the scan', () => {
  assert.deepEqual(duplicateKeyPaths('{"a":"\\"{,}[\\"","a":"x","b":["{\\"a\\":1}"]}'), ['/a']);
});

test('credential-shaped duplicate keys are reported redacted', () => {
  const text = `{"profiles":{"${R2_ACCESS_KEY_ID_SHAPE}":{},"${R2_ACCESS_KEY_ID_SHAPE}":{}}}`;
  assert.deepEqual(duplicateKeyPaths(text), ['/profiles/[REDACTED]']);
});

test('unterminated input ends the scan instead of looping', () => {
  assert.deepEqual(duplicateKeyPaths('{"unterminated'), []);
});
