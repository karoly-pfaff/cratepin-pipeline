import assert from 'node:assert/strict';
import test from 'node:test';

import { NO_RESOLVED_SECRETS, redactSecrets } from './redaction.ts';

const SHA256_DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('redaction removes realistic credential shapes', () => {
  const leaks = [
    'Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261010/auto/s3, Signature=abc123',
    'x-amz-security-token: FwoGZXIvYXdzEJr',
    'https://user:pa@ss@host.example/key?X-Amz-Signature=deadbeef&X-Amz-Credential=AKID',
    'temporary ASIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLE',
    'R2_SECRET_ACCESS_KEY=0123456789abcdef AWS_SESSION_TOKEN=tokenvalue',
    '<SignatureProvided>sigvalue</SignatureProvided><StringToSign>AWS4 line</StringToSign>',
    'resolved secret s3cr3t-value-123',
  ].join('\n');
  const redacted = redactSecrets(leaks, { knownSecretValues: ['s3cr3t-value-123'] });
  const leakedFragments = [
    'abc123',
    'FwoGZXIvYXdzEJr',
    'pa@ss',
    'ss@host',
    'deadbeef',
    'ASIAIOSFODNN7EXAMPLE',
    'AKIAIOSFODNN7EXAMPLE',
    '0123456789abcdef',
    'tokenvalue',
    'sigvalue',
    'AWS4 line',
    's3cr3t-value-123',
  ];
  for (const secret of leakedFragments) assert.ok(!redacted.includes(secret), secret);
});

test('quoted headers and credential variables are redacted in every common notation', () => {
  const notations = [
    ['{"authorization":"Bearer sk_live_123"}', '{"authorization":"[REDACTED]"}'],
    ['Proxy-Authorization: Basic dXNlcjpw', 'Proxy-Authorization: [REDACTED]'],
    ['{"R2_SECRET_ACCESS_KEY":"abcd1234"}', '{"R2_SECRET_ACCESS_KEY":"[REDACTED]"}'],
    ['R2_SECRET_ACCESS_KEY: abcd1234', 'R2_SECRET_ACCESS_KEY: [REDACTED]'],
    ['AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI', 'AWS_SECRET_ACCESS_KEY = [REDACTED]'],
    ['R2_SECRET=ABC123/xyz', 'R2_SECRET=[REDACTED]'],
  ] as const;
  for (const [leaking, expected] of notations) {
    assert.equal(redactSecrets(leaking, NO_RESOLVED_SECRETS), expected);
  }
});

test('redaction keeps digests, object keys and diagnostic URL parameters intact', () => {
  const legitimate = [
    `sha256 ${SHA256_DIGEST}`,
    'projects/authorization:ok/file.png',
    '/assets/Signature=final.png',
    'hasAuthorization: true',
    'https://bucket.example/key?X-Amz-Expires=600&X-Amz-Date=20261010T000000Z&partNumber=2',
  ];
  for (const text of legitimate) assert.equal(redactSecrets(text, NO_RESOLVED_SECRETS), text);
});

test('short known secrets are redacted as whole words only', () => {
  const shortSecret = { knownSecretValues: ['hunter2'] };
  assert.equal(redactSecrets('hunter2 and hunter22', shortSecret), '[REDACTED] and hunter22');
});
