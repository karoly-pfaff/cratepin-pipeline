import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebpEncoding } from '../../config/pipeline-config.ts';
import { normalizedPolicyOf } from '../../media/policies/transform-policy.ts';
import { outputPathOf, possibleOutputPathsOf } from './output-paths.ts';

const PNG = 'image/png';
const WEBP: WebpEncoding = { lossless: true, quality: 80, alphaQuality: 100, keepSmaller: true };

test('an output keeps its source path unless its media type changed', () => {
  assert.equal(
    outputPathOf({ source: 'app/images/Cat.PNG', mediaType: PNG }, PNG),
    'app/images/Cat.PNG',
  );
  assert.equal(
    outputPathOf({ source: 'app/images/cat.png', mediaType: PNG }, 'image/webp'),
    'app/images/cat.webp',
  );
  assert.equal(
    outputPathOf({ source: 'scenes/v1.2/sky.final.png', mediaType: PNG }, 'image/webp'),
    'scenes/v1.2/sky.final.webp',
    'only the last extension of the file name changes',
  );
  assert.throws(() => outputPathOf({ source: 'a.png', mediaType: PNG }, 'image/x-unknown'));
});

test('the possible output paths of each kind of profile are known before converting', () => {
  const original = { source: 'app/cat.png', mediaType: PNG };
  const resize = { width: 64, height: 64, fit: 'contain' as const };
  const cases = [
    [{ kind: 'copy' as const }, ['app/cat.png']],
    [normalizedPolicyOf({ kind: 'image', resize }), ['app/cat.png']],
    [
      normalizedPolicyOf({ kind: 'image', webp: { ...WEBP, keepSmaller: false } }),
      ['app/cat.webp'],
    ],
    [normalizedPolicyOf({ kind: 'image', webp: WEBP }), ['app/cat.png', 'app/cat.webp']],
  ] as const;
  for (const [policy, paths] of cases)
    assert.deepEqual(possibleOutputPathsOf(original, policy), paths);
  const webpOriginal = { source: 'app/cat.webp', mediaType: 'image/webp' };
  assert.deepEqual(
    possibleOutputPathsOf(webpOriginal, normalizedPolicyOf({ kind: 'image', webp: WEBP })),
    ['app/cat.webp'],
  );
});
