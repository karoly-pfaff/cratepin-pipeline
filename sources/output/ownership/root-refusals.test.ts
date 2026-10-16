import assert from 'node:assert/strict';
import test from 'node:test';

import type { OutputRootState } from './output-marker.ts';
import { outputRootError, outputRootIssue } from './root-refusals.ts';

const ROOT = '/project/public/assets';

test('each state a build must not touch has its code and exit; the others have none', () => {
  const cases: readonly [OutputRootState, string | undefined, string | undefined][] = [
    [{ state: 'absent' }, undefined, undefined],
    [{ state: 'empty' }, undefined, undefined],
    [{ state: 'owned' }, undefined, undefined],
    [{ state: 'parent-missing' }, 'OUTPUT_PARENT_MISSING', 'NOT_FOUND'],
    [
      { state: 'not-a-directory', path: '/project/public' },
      'OUTPUT_NOT_A_DIRECTORY',
      'OUTPUT_CONFLICT',
    ],
    [{ state: 'not-owned', names: ['a.png'], nameCount: 1 }, 'OUTPUT_NOT_OWNED', 'OUTPUT_CONFLICT'],
    [
      { state: 'foreign-project', markedProjectId: 'other' },
      'OUTPUT_FOREIGN_PROJECT',
      'OUTPUT_CONFLICT',
    ],
    [{ state: 'mode-changed', markedMode: 'generation' }, 'OUTPUT_MODE_CHANGED', 'OUTPUT_CONFLICT'],
    [{ state: 'marker-invalid' }, 'OUTPUT_MARKER_INVALID', 'OUTPUT_CONFLICT'],
  ];
  for (const [state, issueCode, errorCode] of cases) {
    assert.equal(outputRootIssue(state, ROOT)?.code, issueCode, state.state);
    const error = outputRootError(state, ROOT);
    assert.equal(error?.code, errorCode, state.state);
    if (error !== undefined)
      assert.deepEqual([error.details.reason, error.details.path], [issueCode, ROOT]);
  }
});
