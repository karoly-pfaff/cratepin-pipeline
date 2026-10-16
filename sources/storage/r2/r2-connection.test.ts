import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../config/pipeline-config.ts';
import type { R2Settings } from '../../config/pipeline-config.ts';
import { PipelineError } from '../../errors.ts';
import { renderReportAsText, failedReport } from '../../report.ts';
import { ResolvedSecrets } from '../../redaction.ts';
import { resolveR2Connection } from './r2-connection.ts';
import type { EnvironmentVariables } from './r2-connection.ts';

const R2: R2Settings = defaultConfig().r2;
const WRITER_SECRET = 'writer-secret-value-123456';
const READER_SECRET = 'reader-secret-value-654321';

const COMPLETE_ENVIRONMENT: EnvironmentVariables = {
  R2_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
  R2_BUCKET: 'game-assets',
  R2_WRITE_ACCESS_KEY_ID: 'writer-id',
  R2_WRITE_SECRET_ACCESS_KEY: WRITER_SECRET,
  R2_READ_ACCESS_KEY_ID: 'reader-id',
  R2_READ_SECRET_ACCESS_KEY: READER_SECRET,
};

function failureOf(run: () => unknown): PipelineError {
  try {
    run();
  } catch (error) {
    if (error instanceof PipelineError) return error;
  }
  throw new Error('expected a PipelineError');
}

test('write access resolves endpoint, bucket and only the writer key, remembering secrets', () => {
  const secrets = new ResolvedSecrets();
  const connection = resolveR2Connection(R2, 'write', { variables: COMPLETE_ENVIRONMENT, secrets });
  assert.equal(connection.endpoint.href, 'https://0123456789abcdef.r2.cloudflarestorage.com/');
  assert.equal(connection.bucket, 'game-assets');
  assert.equal(connection.credentials.secretAccessKey, WRITER_SECRET);
  assert.deepEqual(secrets.redactionContext.knownSecretValues, ['writer-id', WRITER_SECRET]);
});

test('read access uses the read-only key and never touches the writer variables', () => {
  const secrets = new ResolvedSecrets();
  const variables = { ...COMPLETE_ENVIRONMENT, R2_WRITE_SECRET_ACCESS_KEY: undefined };
  const connection = resolveR2Connection(R2, 'read', { variables, secrets });
  assert.equal(connection.credentials.accessKeyId, 'reader-id');
  assert.ok(!secrets.redactionContext.knownSecretValues.includes(WRITER_SECRET));
});

test('missing variables are named, values never appear', () => {
  const error = failureOf(() =>
    resolveR2Connection(R2, 'write', {
      variables: { R2_ENDPOINT: COMPLETE_ENVIRONMENT.R2_ENDPOINT, R2_WRITE_SECRET_ACCESS_KEY: '' },
      secrets: new ResolvedSecrets(),
    }),
  );
  assert.equal(error.code, 'CONFIG_INVALID');
  assert.equal(
    error.details.missing,
    'R2_BUCKET, R2_WRITE_ACCESS_KEY_ID, R2_WRITE_SECRET_ACCESS_KEY',
  );
});

test('a bucket-scoped endpoint naming the configured bucket is cut back to the account', () => {
  for (const endpoint of [
    'https://0123456789abcdef.r2.cloudflarestorage.com/game-assets',
    'https://0123456789abcdef.r2.cloudflarestorage.com/game-assets/',
  ]) {
    const variables = { ...COMPLETE_ENVIRONMENT, R2_ENDPOINT: endpoint };
    const secrets = new ResolvedSecrets();
    const connection = resolveR2Connection(R2, 'write', { variables, secrets });
    assert.equal(connection.endpoint.href, 'https://0123456789abcdef.r2.cloudflarestorage.com/');
    assert.equal(connection.bucket, 'game-assets');
  }
});

test('endpoints are https origins, or name their own bucket; plain http only to loopback', () => {
  const invalidEndpoints = [
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- proves plain http is refused
    'http://account.r2.cloudflarestorage.com',
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the bucket path does not help
    'http://account.r2.cloudflarestorage.com/game-assets',
    'https://user:pass@account.r2.cloudflarestorage.com',
    'https://user:pass@account.r2.cloudflarestorage.com/game-assets',
    'https://account.r2.cloudflarestorage.com/bucket',
    'https://account.r2.cloudflarestorage.com/game-assets/key',
    'https://account.r2.cloudflarestorage.com/game-assets-old',
    'https://account.r2.cloudflarestorage.com/Game-Assets',
    'https://account.r2.cloudflarestorage.com/game-assets?X-Amz-Signature=abc',
    'https://account.r2.cloudflarestorage.com/?X-Amz-Signature=abc',
    'https://account.r2.cloudflarestorage.com/game-assets#top',
    'not a url',
  ];
  for (const endpoint of invalidEndpoints) {
    const variables = { ...COMPLETE_ENVIRONMENT, R2_ENDPOINT: endpoint };
    const error = failureOf(() =>
      resolveR2Connection(R2, 'write', { variables, secrets: new ResolvedSecrets() }),
    );
    assert.equal(error.details.variable, 'R2_ENDPOINT', endpoint);
    assert.ok(!error.message.includes(endpoint), endpoint);
    assert.ok(!error.message.includes('game-assets'), 'the bucket value is never echoed');
    assert.match(error.message, /R2_BUCKET/);
  }
  const loopback = { ...COMPLETE_ENVIRONMENT, R2_ENDPOINT: 'http://127.0.0.1:9000' };
  assert.equal(
    resolveR2Connection(R2, 'write', { variables: loopback, secrets: new ResolvedSecrets() })
      .endpoint.port,
    '9000',
  );
});

test('bucket names follow the R2 rules', () => {
  for (const bucket of ['ab', 'Game-Assets', '-assets', 'assets-', 'a'.repeat(64), 'my_bucket']) {
    const variables = { ...COMPLETE_ENVIRONMENT, R2_BUCKET: bucket };
    const error = failureOf(() =>
      resolveR2Connection(R2, 'write', { variables, secrets: new ResolvedSecrets() }),
    );
    assert.equal(error.details.variable, 'R2_BUCKET', bucket);
  }
});

test('the public-http read transport has no S3 credentials to resolve', () => {
  const publicRead: R2Settings = {
    ...R2,
    read: { transport: 'public-http', publicBaseUrl: 'https://assets.example.com/' },
  };
  const error = failureOf(() =>
    resolveR2Connection(publicRead, 'read', {
      variables: COMPLETE_ENVIRONMENT,
      secrets: new ResolvedSecrets(),
    }),
  );
  assert.equal(error.code, 'CONFIG_INVALID');
});

test('a report rendered with the run secrets never shows a resolved key', () => {
  const secrets = new ResolvedSecrets();
  resolveR2Connection(R2, 'write', { variables: COMPLETE_ENVIRONMENT, secrets });
  const leaky = new PipelineError('AUTH_FAILED', `rejected key ${WRITER_SECRET}`);
  const text = renderReportAsText(failedReport('push', leaky), secrets.redactionContext);
  assert.ok(!text.includes(WRITER_SECRET));
});
