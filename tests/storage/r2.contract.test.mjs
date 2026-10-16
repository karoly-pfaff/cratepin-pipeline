import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { sendS3Request } from '../../sources/storage/r2/s3-requests.ts';

import {
  createR2BlobReader,
  createR2BlobWriter,
  defaultConfig,
  ResolvedSecrets,
  resolveR2Connection,
  transferSettingsFrom,
  verifyByReadback,
} from '../../sources/index.ts';

// Opt-in contract test against a real R2 bucket: set CRATEPIN_R2_CONTRACT=1 and the usual
// R2_ENDPOINT, R2_BUCKET, R2_WRITE_* and R2_READ_* variables. It writes a few small objects under
// a fresh "cratepin-contract/<uuid>/" prefix and never deletes anything; remove that
// prefix by hand afterwards (the multipart case adds an 11 MiB object). Skipped by default, so
// ordinary checks never touch the network.
const IS_ENABLED = process.env.CRATEPIN_R2_CONTRACT === '1';

/** Why the read-only case cannot run, or `false`: it needs a read key separate from the writer's. */
function readOnlyCaseSkip() {
  if (!IS_ENABLED) return true;
  const { R2_READ_ACCESS_KEY_ID: readKey, R2_WRITE_ACCESS_KEY_ID: writeKey } = process.env;
  return readKey === writeKey ? 'R2_READ_* holds the writer key, not a read-only token' : false;
}

function uploadOf(key, text) {
  const bytes = Buffer.from(text);
  return {
    key,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    openBody: async function* () {
      yield bytes;
    },
  };
}

async function textOf(chunks) {
  const parts = [];
  for await (const chunk of chunks) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString();
}

test(
  'real R2: create-only PUT, conditional refusal, payload hash check, readback',
  { skip: !IS_ENABLED },
  async () => {
    const environment = { variables: process.env, secrets: new ResolvedSecrets() };
    const r2 = defaultConfig().r2;
    const writer = createR2BlobWriter(resolveR2Connection(r2, 'write', environment));
    const reader = createR2BlobReader(resolveR2Connection(r2, 'read', environment));
    const key = `cratepin-contract/${randomUUID()}/object.txt`;
    assert.equal(await writer.createBlobIfAbsent(uploadOf(key, 'first')), 'created');
    assert.equal(await writer.createBlobIfAbsent(uploadOf(key, 'second')), 'already-exists');
    assert.equal(await textOf(reader.readBlob(key)), 'first');
    assert.deepEqual(await reader.statBlob(key), { key, bytes: 5 });
    // Sent below the writer, whose own content check would refuse it before any byte left.
    const declared = Buffer.from('declared');
    const response = await sendS3Request(resolveR2Connection(r2, 'write', environment), {
      method: 'PUT',
      key: `${key}.lying`,
      headers: { 'content-length': String(declared.length) },
      body: Buffer.from('actual!!'),
      payloadSha256: createHash('sha256').update(declared).digest('hex'),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /XAmzContentSHA256Mismatch/);
    assert.equal(await reader.statBlob(`${key}.lying`), undefined);
  },
);

test(
  'real R2: multipart upload in 5 MiB parts completes and reads back exactly',
  { skip: !IS_ENABLED },
  async () => {
    const environment = { variables: process.env, secrets: new ResolvedSecrets() };
    const config = defaultConfig();
    const limits = {
      ...config.limits,
      multipartThresholdBytes: 5 * 1024 * 1024,
      multipartPartBytes: 5 * 1024 * 1024,
    };
    const settings = transferSettingsFrom(limits);
    const writer = createR2BlobWriter(
      resolveR2Connection(config.r2, 'write', environment),
      settings,
    );
    const reader = createR2BlobReader(
      resolveR2Connection(config.r2, 'read', environment),
      settings,
    );
    const content = Buffer.alloc(11 * 1024 * 1024 + 123, 7);
    const key = `cratepin-contract/${randomUUID()}/large.bin`;
    const upload = {
      key,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      openBody: async function* () {
        yield content;
      },
    };
    assert.equal(await writer.createBlobIfAbsent(upload), 'created');
    const stored = [];
    for await (const chunk of reader.readBlob(key)) stored.push(Buffer.from(chunk));
    assert.ok(Buffer.concat(stored).equals(content));
  },
);

test(
  'real R2: a write signed with the read-only token is refused and stores nothing',
  { skip: readOnlyCaseSkip() },
  async () => {
    const environment = { variables: process.env, secrets: new ResolvedSecrets() };
    const r2 = defaultConfig().r2;
    const readConnection = resolveR2Connection(r2, 'read', environment);
    const key = `cratepin-contract/${randomUUID()}/read-only.txt`;
    await assert.rejects(
      createR2BlobWriter(readConnection).createBlobIfAbsent(uploadOf(key, 'refused')),
      (error) => error.code === 'AUTH_FAILED',
    );
    assert.equal(await createR2BlobReader(readConnection).statBlob(key), undefined);
  },
);

function contractConnections() {
  const environment = { variables: process.env, secrets: new ResolvedSecrets() };
  const r2 = defaultConfig().r2;
  return {
    write: resolveR2Connection(r2, 'write', environment),
    read: resolveR2Connection(r2, 'read', environment),
  };
}

test(
  'real R2: an ETag is not the SHA-256, and same-size other bytes fail only the readback hash',
  { skip: !IS_ENABLED },
  async () => {
    const { write, read } = contractConnections();
    const key = `cratepin-contract/${randomUUID()}/same-size.txt`;
    assert.equal(
      await createR2BlobWriter(write).createBlobIfAbsent(uploadOf(key, 'other!')),
      'created',
    );
    const head = await sendS3Request(read, { method: 'HEAD', key });
    const etag = head.headers.get('etag')?.replaceAll('"', '');
    assert.notEqual(etag, createHash('sha256').update('other!').digest('hex'));
    assert.equal(
      Number(head.headers.get('content-length')),
      6,
      'the size matches the expected one',
    );
    const expected = createHash('sha256').update('right!').digest('hex');
    await assert.rejects(
      verifyByReadback(createR2BlobReader(read), {
        objectKey: key,
        sha256: expected,
        bytes: 6,
        ids: [],
      }),
      (error) => error.code === 'INTEGRITY_MISMATCH',
    );
  },
);

test(
  'real R2: two writers of one key at once: exactly one creates it, the readback finds its bytes',
  { skip: !IS_ENABLED },
  async () => {
    const { write, read } = contractConnections();
    const key = `cratepin-contract/${randomUUID()}/race.txt`;
    const writer = createR2BlobWriter(write);
    const outcomes = await Promise.all([
      writer.createBlobIfAbsent(uploadOf(key, 'same bytes')),
      writer.createBlobIfAbsent(uploadOf(key, 'same bytes')),
    ]);
    assert.deepEqual(outcomes.toSorted(), ['already-exists', 'created']);
    assert.equal(await textOf(createR2BlobReader(read).readBlob(key)), 'same bytes');
  },
);

test(
  'real R2: a multipart upload whose key another writer took meanwhile is refused and aborted',
  { skip: !IS_ENABLED },
  async () => {
    const { write, read } = contractConnections();
    const key = `cratepin-contract/${randomUUID()}/taken-during-upload.bin`;
    const content = Buffer.alloc(5 * 1024 * 1024 + 17, 3);
    const upload = {
      key,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      openBody: async function* () {
        // The other writer stores the key after the upload started, before it completes.
        await createR2BlobWriter(write).createBlobIfAbsent(uploadOf(key, 'first writer'));
        yield content;
      },
    };
    const limits = {
      ...defaultConfig().limits,
      multipartThresholdBytes: 5 * 1024 * 1024,
      multipartPartBytes: 5 * 1024 * 1024,
    };
    const writer = createR2BlobWriter(write, transferSettingsFrom(limits));
    assert.equal(await writer.createBlobIfAbsent(upload), 'already-exists');
    assert.equal(await textOf(createR2BlobReader(read).readBlob(key)), 'first writer');
  },
);

test(
  'real R2: two multipart writers of one key at once: one creates it, the other gets already-exists',
  { skip: !IS_ENABLED },
  async () => {
    const { write, read } = contractConnections();
    const key = `cratepin-contract/${randomUUID()}/two-multipart-writers.bin`;
    const content = Buffer.alloc(5 * 1024 * 1024 + 29, 9);
    const upload = {
      key,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      openBody: async function* () {
        yield content;
      },
    };
    const limits = {
      ...defaultConfig().limits,
      multipartThresholdBytes: 5 * 1024 * 1024,
      multipartPartBytes: 5 * 1024 * 1024,
    };
    const settings = transferSettingsFrom(limits);
    const outcomes = await Promise.all([
      createR2BlobWriter(write, settings).createBlobIfAbsent(upload),
      createR2BlobWriter(write, settings).createBlobIfAbsent(upload),
    ]);
    assert.deepEqual(outcomes.toSorted(), ['already-exists', 'created']);
    const stored = [];
    for await (const chunk of createR2BlobReader(read).readBlob(key))
      stored.push(Buffer.from(chunk));
    assert.ok(Buffer.concat(stored).equals(content));
  },
);

/** One raw request against the contract scratch prefix: status and S3 error code. */
async function answerOf(connection, request) {
  const response = await sendS3Request(connection, request);
  const text = await response.text();
  return `${String(response.status)} ${/<Code>([^<]+)<\/Code>/u.exec(text)?.[1] ?? '-'}`;
}

test(
  'real R2: abort answers that the tool relies on: 204 after completion, 404 NoSuchUpload unknown',
  { skip: !IS_ENABLED },
  async () => {
    const { write } = contractConnections();
    const key = `cratepin-contract/${randomUUID()}/abort-answers.bin`;
    const started = await sendS3Request(write, { method: 'POST', key, query: { uploads: '' } });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/u.exec(await started.text())?.[1];
    assert.ok(uploadId !== undefined);
    const part = Buffer.from('one small last part');
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const partAnswer = await sendS3Request(write, {
      method: 'PUT',
      key,
      query: { partNumber: '1', uploadId },
      headers: { 'content-length': String(part.length) },
      body: part,
      payloadSha256: sha(part),
    });
    const etag = partAnswer.headers.get('etag');
    await partAnswer.arrayBuffer();
    const xml = Buffer.from(
      `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
    );
    const completion = {
      method: 'POST',
      key,
      query: { uploadId },
      headers: { 'content-length': String(xml.length), 'if-none-match': '*' },
      body: xml,
      payloadSha256: sha(xml),
    };
    assert.equal(await answerOf(write, completion), '200 -');
    assert.equal(await answerOf(write, { method: 'DELETE', key, query: { uploadId } }), '204 -');
    const unknown = { method: 'DELETE', key, query: { uploadId: 'not-an-upload-id' } };
    assert.equal(await answerOf(write, unknown), '404 NoSuchUpload');
  },
);
