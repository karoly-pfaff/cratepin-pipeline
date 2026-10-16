import assert from 'node:assert/strict';
import test from 'node:test';

import { failed, passed } from '../../doctor/doctor-check.ts';
import { PipelineError } from '../../errors.ts';
import { ResolvedSecrets } from '../../redaction.ts';
import { renderReportAsJson, renderReportAsText } from '../../report.ts';
import { doctorReport } from './doctor-report.ts';

const RESOLVED_SECRET = 'resolved-secret-value-0123456789';

function reportWithSecretInsideAFailure(): ReturnType<typeof doctorReport> {
  const echoed = new PipelineError('AUTH_FAILED', `storage said: bad key ${RESOLVED_SECRET}`, {
    key: `objects/${RESOLVED_SECRET}`,
  });
  const checks = [passed('config', 'Project "demo".'), failed('read-access', echoed)];
  return doctorReport({ checks }, { toolVersion: '1.0.0' }, false);
}

test('a resolved key inside a failed check is redacted in the text and JSON report', () => {
  const secrets = new ResolvedSecrets();
  secrets.remember(RESOLVED_SECRET);
  const report = reportWithSecretInsideAFailure();
  assert.ok(JSON.stringify(report).includes(RESOLVED_SECRET), 'the secret reached the report');
  for (const rendered of [
    renderReportAsText(report, secrets.redactionContext),
    renderReportAsJson(report, secrets.redactionContext),
  ]) {
    assert.ok(!rendered.includes(RESOLVED_SECRET), 'a resolved key was rendered');
    assert.match(rendered, /\[REDACTED\]/);
  }
});

test('every failed check keeps its code and details; the first failure is the error', () => {
  const lockError = new PipelineError('INVALID_DATA', 'The committed lock is invalid.', {
    issueCount: 2,
  });
  const outputError = new PipelineError('OUTPUT_CONFLICT', 'Not owned.', { reason: 'X' });
  const checks = [failed('lock', lockError), failed('output', outputError)];
  const report = doctorReport({ checks }, {}, true);
  assert.equal(report.error?.code, 'INVALID_DATA');
  assert.deepEqual(report.facts.checks, [
    {
      check: 'lock',
      status: 'failed',
      code: 'INVALID_DATA',
      finding: lockError.message,
      details: ['issueCount: 2'],
    },
    {
      check: 'output',
      status: 'failed',
      code: 'OUTPUT_CONFLICT',
      finding: 'Not owned.',
      details: ['reason: X'],
    },
  ]);
});
