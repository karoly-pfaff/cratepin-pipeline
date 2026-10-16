import assert from 'node:assert/strict';
import test from 'node:test';

import { checkedProjectIn } from '../../catalog/source-fixtures.test-support.ts';
import { PipelineError } from '../../errors.ts';
import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { cachePruneReport } from './cache-prune-report.ts';

const REMOVED = {
  kind: 'part' as const,
  path: '/cache/incoming/a.part',
  name: 'incoming/a.part',
  bytes: 3,
};

test('a prune that stopped midway fails, still listing what it removed', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    const cancelled = new PipelineError('CANCELLED', 'Operation was cancelled.');
    const plan = {
      referenced: [],
      referencedDerivatives: [],
      missingReferencedCount: 0,
      removable: [REMOVED],
      unknownNames: [],
    };
    const result = {
      cacheExists: true,
      plan,
      removal: { removed: [REMOVED], error: cancelled },
      liveClaims: [],
      deadClaimFiles: [],
    };
    const report = cachePruneReport(project, result, false);
    assert.equal(report.status, 'failed');
    assert.equal(report.error?.code, 'CANCELLED');
    assert.deepEqual(report.facts.removed, [{ kind: 'part', name: 'incoming/a.part', bytes: 3 }]);
    assert.equal(report.facts.removedBytes, 3);
  });
});

test('kept derivative files are counted and measured file by file', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    const derivativeFile = (kind: 'derivative' | 'derivativeRecord', bytes: number) => ({
      kind,
      path: `/cache/derivatives/${kind}`,
      name: `derivatives/${kind}`,
      bytes,
    });
    const plan = {
      referenced: [],
      referencedDerivatives: [
        derivativeFile('derivative', 400),
        derivativeFile('derivativeRecord', 25),
      ],
      missingReferencedCount: 0,
      removable: [],
      unknownNames: [],
    };
    const result = { cacheExists: true, plan, liveClaims: [], deadClaimFiles: [] };
    const { facts } = cachePruneReport(project, result, true);
    assert.equal(facts.referencedDerivativeFileCount, 2);
    assert.equal(facts.referencedDerivativeFileBytes, 425);
    assert.equal(facts.referencedCount, 0, 'derivatives are not locked originals');
  });
});
