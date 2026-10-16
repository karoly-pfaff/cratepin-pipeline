import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { checkedProjectIn, writeSources } from '../../catalog/source-fixtures.test-support.ts';
import { PipelineError } from '../../errors.ts';
import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { ResolvedSecrets } from '../../redaction.ts';
import { parseInvocation } from '../arguments.ts';
import type { CommandRuntime } from '../command-runtime.ts';
import { pushSources } from './push-command.ts';

function isCancelled(error: unknown): boolean {
  return error instanceof PipelineError && error.code === 'CANCELLED';
}

test('a push cancelled during its local preview stops before reading any credential', async () => {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, { 'images/a.png': 'a' });
    await checkedProjectIn(workspace);
    const invocation = parseInvocation([
      'push',
      '--config',
      join(workspace, 'cratepin.config.json'),
    ]);
    const secrets = new ResolvedSecrets();
    const runtime: CommandRuntime = {
      variables: {},
      secrets,
      cancellationSignal: () => AbortSignal.abort(),
    };
    // With no variables, reading credentials would fail with CONFIG_INVALID instead.
    await assert.rejects(pushSources(invocation, runtime), isCancelled);
    assert.deepEqual(secrets.redactionContext.knownSecretValues, []);
  });
});
