import assert from 'node:assert/strict';
import test from 'node:test';

import { derivedOutputUrlPath, outputUrlPathIssues } from './output-url-rules.ts';

test('the URL path is what follows the last "public" segment, in any letter case', () => {
  const cases = [
    ['public/assets', 'assets'],
    ['apps/game/PUBLIC/assets/gen', 'assets/gen'],
    ['public', ''],
    ['www/media', undefined],
  ] as const;
  for (const [outputDir, urlPath] of cases) assert.equal(derivedOutputUrlPath(outputDir), urlPath);
});

test('a given URL path is never second-guessed by the derivation', () => {
  assert.deepEqual(outputUrlPathIssues({ outputUrlPath: 'media' }, 'www/media'), []);
  assert.deepEqual(outputUrlPathIssues({}, 'public/assets'), []);
  assert.equal(outputUrlPathIssues({}, 'www/media').length, 1);
  assert.equal(outputUrlPathIssues({}, 'public/my assets').length, 1);
});
