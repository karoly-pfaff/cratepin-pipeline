import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../../config/pipeline-config.ts';
import type { PipelineConfig } from '../../config/pipeline-config.ts';
import { PipelineError } from '../../errors.ts';
import { encoderFingerprint } from '../encoding/encoder-fingerprint.ts';
import { profileSelectorFor } from './profile-selection.ts';
import { derivativeKeyOf } from './transform-policy.ts';

const WEBP = { lossless: true, quality: 80, alphaQuality: 100, keepSmaller: true };

const CONFIG: PipelineConfig = {
  ...defaultConfig(),
  profiles: {
    'actor-512': { kind: 'image', resize: { width: 512, height: 512, fit: 'contain' } },
    artwork: { kind: 'image', webp: WEBP },
  },
  profileRules: [
    { match: 'scenes/*/characters/**/*.png', profile: 'actor-512' },
    { match: 'scenes/**/*.png', profile: 'artwork' },
  ],
  defaultProfile: 'copy',
};
const select = profileSelectorFor(CONFIG);

test('an asset entry wins, then the first matching rule, then the default profile', () => {
  const fox = 'scenes/forest/characters/fox.png';
  const overridden = select({ source: fox, profile: 'artwork' });
  assert.deepEqual([overridden.name, overridden.from], ['artwork', 'asset']);
  assert.equal(select({ source: fox }).name, 'actor-512', 'first rule, not the broader one');
  assert.equal(select({ source: 'scenes/forest/sky.png' }).name, 'artwork');
  const voice = select({ source: 'voice/hu/hello.mp3' });
  assert.deepEqual([voice.name, voice.from, voice.policy], ['copy', 'default', { kind: 'copy' }]);
});

test('rules match ignoring letter case, like the include patterns', () => {
  assert.equal(select({ source: 'Scenes/Forest/Characters/Fox.PNG' }).name, 'actor-512');
});

/** The PROFILE_UNKNOWN failure for "gone" on scenes/a.png, named from `from`, with its remedy. */
function refusedBecause(from: string, remedy: string): object {
  return {
    name: PipelineError.name,
    details: { reason: 'PROFILE_UNKNOWN', profile: 'gone', from, source: 'scenes/a.png' },
    message: new RegExp(
      `^Profile "gone" for scenes/a[.]png is not defined in the config: .*${remedy}`,
      'u',
    ),
  };
}

test('a profile the config no longer defines is refused, never replaced', () => {
  assert.throws(
    () => select({ source: 'scenes/a.png', profile: 'gone' }),
    refusedBecause('asset', 'change the entry and push again'),
  );
});

test('an undefined profile named by a rule or by the default says which one to fix', () => {
  const byRule = profileSelectorFor({
    ...CONFIG,
    profileRules: [{ match: 'scenes/*.png', profile: 'gone' }],
  });
  assert.throws(() => byRule({ source: 'scenes/a.png' }), refusedBecause('rule', 'fix the rule'));
  const byDefault = profileSelectorFor({ ...CONFIG, profileRules: [], defaultProfile: 'gone' });
  assert.throws(
    () => byDefault({ source: 'scenes/a.png' }),
    refusedBecause('default', 'change defaultProfile'),
  );
});

test('an override on one asset gives it a different derivative key', () => {
  const sky = 'scenes/forest/sky.png';
  const keyOf = (profile?: string): string =>
    derivativeKeyOf({
      sourceSha256: 'a'.repeat(64),
      policy: select({ source: sky, ...(profile === undefined ? {} : { profile }) }).policy,
      fingerprint: encoderFingerprint(),
    });
  assert.notEqual(keyOf('actor-512'), keyOf());
  assert.equal(
    keyOf('artwork'),
    keyOf(),
    'the same profile by override or by rule is one derivative',
  );
});
