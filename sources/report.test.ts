import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineError } from './errors.ts';
import { NO_RESOLVED_SECRETS } from './redaction.ts';
import {
  exitCodeOf,
  failedReport,
  renderReportAsJson,
  renderReportAsText,
  succeededReport,
} from './report.ts';
import type { OperationReport } from './report.ts';

const AUTH_FAILURE_EXIT_CODE = 5;

function parsedJsonReport(
  report: OperationReport,
  knownSecretValues: readonly string[],
): OperationReport {
  return JSON.parse(renderReportAsJson(report, { knownSecretValues })) as OperationReport;
}

function authFailureReport(knownSecret: string): OperationReport {
  const error = new PipelineError(
    'AUTH_FAILED',
    `Server said "Authorization: Bearer abc" for ${knownSecret}`,
    {
      key: 'projects/demo/sources/sha256/abc',
      endpoint: 'https://u:p@r2.example/bucket?X-Amz-Signature=sig',
    },
  );
  return failedReport('pull', error, {
    facts: { orphanedKeys: ['k1', 'k2'], uploaded: 3 },
    issues: [{ path: '/r2', code: 'CONFIG_INVALID', message: 'line one\nforged: line' }],
  });
}

function assertNoSecretsIn(outputs: readonly string[]): void {
  const secrets = ['Bearer abc', 'u:p@', '=sig', 'pa"ss', 'pa\\"ss'];
  for (const output of outputs) {
    for (const secret of secrets) assert.ok(!output.includes(secret), `${secret} in ${output}`);
  }
}

test('text and JSON renderings carry the same redacted state and JSON always parses', () => {
  const knownSecret = 'pa"ss\\word-123';
  const report = authFailureReport(knownSecret);
  const text = renderReportAsText(report, { knownSecretValues: [knownSecret] });
  const json = parsedJsonReport(report, [knownSecret]);
  assertNoSecretsIn([text, JSON.stringify(json)]);
  assert.ok(json.error);
  const sharedFacts = [
    json.error.code,
    String(json.error.details.key),
    json.issues[0]?.path ?? '',
    'k1, k2',
    'uploaded: 3',
  ];
  for (const fact of sharedFacts) assert.ok(text.includes(fact), fact);
  assert.ok(text.includes('retryable: no') && !json.error.isRetryable);
  assert.equal(exitCodeOf(report), AUTH_FAILURE_EXIT_CODE);
});

test('text output escapes control characters so values cannot forge lines', () => {
  const text = renderReportAsText(authFailureReport('unused-secret'), NO_RESOLVED_SECRETS);
  assert.ok(text.includes('line one\\nforged: line'));
  assert.ok(!text.includes('\nforged'));
});

test('success has exit code 0 and a retryable failure says so', () => {
  assert.equal(exitCodeOf(succeededReport('hash', { bytes: 3 })), 0);
  const retryable = failedReport('pull', new PipelineError('TRANSIENT_TRANSFER', 'reset'));
  assert.match(renderReportAsText(retryable, NO_RESOLVED_SECRETS), /retryable: yes/);
});

test('report field names stay distinct after redaction', () => {
  const report = succeededReport('pull', { 'Authorization: a': 1, 'Authorization: b': 2 });
  assert.equal(Object.keys(parsedJsonReport(report, []).facts).length, 2);
});

test('listings render one line per row in text and stay structured in JSON', () => {
  const report = succeededReport(
    'scan',
    {
      sources: [
        { path: 'a.png', bytes: 3 },
        { path: 'b\nforged.png', bytes: 4 },
      ],
      empty: [],
    },
    [{ path: 'a.png', code: 'DUPLICATE_CONTENT', message: 'same bytes' }],
  );
  const text = renderReportAsText(report, NO_RESOLVED_SECRETS);
  assert.match(text, /\n {2}sources:\n {4}- path: a\.png, bytes: 3\n {4}- path: b\\nforged\.png/);
  assert.match(text, /DUPLICATE_CONTENT at a\.png: same bytes/);
  assert.deepEqual(parsedJsonReport(report, []).facts.sources, report.facts.sources);
  assert.equal(exitCodeOf(report), 0);
});

test('list cells of a listing row render in brackets', () => {
  const report = succeededReport('push --dry-run', {
    uploads: [{ objectKey: 'k', ids: ['a', 'b'] }],
  });
  assert.match(renderReportAsText(report, NO_RESOLVED_SECRETS), /- objectKey: k, ids: \[a, b\]/);
});
