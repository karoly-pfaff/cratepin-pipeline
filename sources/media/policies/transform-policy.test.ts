import assert from 'node:assert/strict';
import test from 'node:test';

import { encoderFingerprint } from '../encoding/encoder-fingerprint.ts';
import { derivativeKeyOf, normalizedPolicyOf } from './transform-policy.ts';
import type { DerivativeInputs } from './transform-policy.ts';

const SHA = 'a'.repeat(64);
const WEBP = { lossless: true, quality: 80, alphaQuality: 100, keepSmaller: true };

function inputs(overrides: Partial<DerivativeInputs> = {}): DerivativeInputs {
  return {
    sourceSha256: SHA,
    policy: normalizedPolicyOf({ kind: 'image', webp: WEBP }),
    fingerprint: encoderFingerprint(),
    ...overrides,
  };
}

test('a normalized policy spells out the configured and chosen encoder settings', () => {
  assert.deepEqual(normalizedPolicyOf({ kind: 'image', webp: WEBP }), {
    kind: 'image',
    resize: null,
    output: { format: 'webp', ...WEBP, effort: 4, exact: true },
    colour: 'srgb',
    metadata: 'strip',
  });
  assert.deepEqual(normalizedPolicyOf({ kind: 'copy' }), { kind: 'copy' });
  const resized = normalizedPolicyOf({
    kind: 'image',
    resize: { width: 8, height: 4, fit: 'contain' },
  });
  assert.deepEqual(resized, {
    kind: 'image',
    resize: {
      width: 8,
      height: 4,
      fit: 'contain',
      kernel: 'lanczos3',
      enlarge: false,
      padding: 'transparent',
    },
    output: { format: 'same', pngCompressionLevel: 9 },
    colour: 'srgb',
    metadata: 'strip',
  });
});

test('the derivative key changes with the source, the policy and the encoder, not with key order', () => {
  const base = derivativeKeyOf(inputs());
  assert.match(base, /^[0-9a-f]{64}$/u);
  assert.equal(derivativeKeyOf(inputs()), base);
  const reordered = {
    fingerprint: encoderFingerprint(),
    policy: inputs().policy,
    sourceSha256: SHA,
  };
  assert.equal(derivativeKeyOf(reordered), base);
  const changed = [
    inputs({ sourceSha256: 'b'.repeat(64) }),
    inputs({ policy: normalizedPolicyOf({ kind: 'image', webp: { ...WEBP, quality: 81 } }) }),
    inputs({
      policy: normalizedPolicyOf({ kind: 'image', webp: { ...WEBP, keepSmaller: false } }),
    }),
    inputs({ policy: normalizedPolicyOf({ kind: 'copy' }) }),
    inputs({ fingerprint: { ...encoderFingerprint(), libvips: '0.0.0' } }),
    inputs({ fingerprint: { ...encoderFingerprint(), arch: 'other' } }),
  ];
  for (const variant of changed) assert.notEqual(derivativeKeyOf(variant), base);
});
