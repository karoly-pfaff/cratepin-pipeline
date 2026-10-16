import assert from 'node:assert/strict';
import test from 'node:test';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { canonicalRequestOf, EMPTY_PAYLOAD_SHA256, encodeRfc3986, signRequest } from './sig-v4.ts';
import type { RequestToSign } from './sig-v4.ts';

// The worked examples of AWS's "Signature Calculations for the Authorization Header: Transferring
// Payload in a Single Chunk" (Amazon S3 API reference), with their published credentials.
const EXAMPLE_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const EXAMPLE_SCOPE = { region: 'us-east-1', service: 's3', now: new Date('2013-05-24T00:00:00Z') };
const EXAMPLE_BUCKET = 'https://examplebucket.s3.amazonaws.com';

function signatureOf(request: RequestToSign): string {
  const { authorization = '' } = signRequest(request, EXAMPLE_CREDENTIALS, EXAMPLE_SCOPE);
  return /Signature=([0-9a-f]{64})$/.exec(authorization)?.[1] ?? '';
}

test('GET object with a range matches the published example signature', () => {
  const request = {
    method: 'GET',
    url: new URL(`${EXAMPLE_BUCKET}/test.txt`),
    headers: { range: 'bytes=0-9' },
    payloadSha256: EMPTY_PAYLOAD_SHA256,
  };
  assert.equal(
    signatureOf(request),
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  const { authorization } = signRequest(request, EXAMPLE_CREDENTIALS, EXAMPLE_SCOPE);
  assert.match(
    authorization ?? '',
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /,
  );
});

test('PUT object with an encoded key and extra headers matches the published example', () => {
  const signature = signatureOf({
    method: 'PUT',
    url: new URL(`${EXAMPLE_BUCKET}/test$file.text`),
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payloadSha256: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
  });
  assert.equal(signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('query strings are signed sorted and encoded, with empty values', () => {
  const lifecycle = signatureOf({
    method: 'GET',
    url: new URL(`${EXAMPLE_BUCKET}/?lifecycle`),
    headers: {},
    payloadSha256: EMPTY_PAYLOAD_SHA256,
  });
  assert.equal(lifecycle, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  const listing = signatureOf({
    method: 'GET',
    url: new URL(`${EXAMPLE_BUCKET}/?prefix=J&max-keys=2`),
    headers: {},
    payloadSha256: EMPTY_PAYLOAD_SHA256,
  });
  assert.equal(listing, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('RFC 3986 encoding keeps only unreserved characters', () => {
  assert.equal(encodeRfc3986("a b!'()*~._-é/"), 'a%20b%21%27%28%29%2A~._-%C3%A9%2F');
});

test('the returned headers carry date, payload hash and authorization but not host', () => {
  const headers = signRequest(
    {
      method: 'HEAD',
      url: new URL(`${EXAMPLE_BUCKET}/a`),
      headers: {},
      payloadSha256: EMPTY_PAYLOAD_SHA256,
    },
    EXAMPLE_CREDENTIALS,
    EXAMPLE_SCOPE,
  );
  assert.deepEqual(Object.keys(headers).toSorted(compareCodeUnits), [
    'authorization',
    'x-amz-content-sha256',
    'x-amz-date',
  ]);
  assert.ok(!JSON.stringify(headers).includes(EXAMPLE_CREDENTIALS.secretAccessKey));
});

test('the canonical request matches a hand-derived one for the tricky parts', () => {
  const payloadSha256 = 'a'.repeat(64);
  const canonical = canonicalRequestOf(
    {
      method: 'PUT',
      url: new URL(
        'http://127.0.0.1:9000/bucket/odd%20name/%C3%BCnnep%2B.png?uploadId=a%2Fb&partNumber=2&partNumber=1',
      ),
      headers: { 'X-Custom': '  padded    value  ' },
      payloadSha256,
    },
    { region: 'auto', service: 's3', now: new Date('2026-10-10T00:00:00Z') },
  );
  const expected = [
    'PUT',
    '/bucket/odd%20name/%C3%BCnnep%2B.png',
    'partNumber=1&partNumber=2&uploadId=a%2Fb',
    'host:127.0.0.1:9000',
    `x-amz-content-sha256:${payloadSha256}`,
    'x-amz-date:20261010T000000Z',
    'x-custom:padded value',
    '',
    'host;x-amz-content-sha256;x-amz-date;x-custom',
    payloadSha256,
  ].join(String.fromCharCode(10));
  assert.equal(canonical, expected);
});
