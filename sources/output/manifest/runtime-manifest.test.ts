import assert from 'node:assert/strict';
import test from 'node:test';

import type { ManifestAsset } from '../../contracts.ts';
import { manifestTextOf } from './runtime-manifest.ts';

const HEADER = {
  projectId: 'demo',
  outputMode: 'path-preserving' as const,
  generation: 'f'.repeat(64),
};

function assetAt(url: string, extra: Partial<ManifestAsset> = {}): ManifestAsset {
  return {
    sourceSha256: 'b'.repeat(64),
    source: url,
    category: 'image',
    sha256: 'a'.repeat(64),
    bytes: 3,
    mediaType: 'image/png',
    url,
    ...extra,
  };
}

test('assets are written in code-unit order of their IDs, integer-like ones included', () => {
  const text = manifestTextOf(HEADER, [
    { id: 'a', asset: assetAt('a.png') },
    { id: '2', asset: assetAt('2.png') },
    { id: '10', asset: assetAt('10.png') },
  ]);
  assert.deepEqual(
    [...text.matchAll(/^ {4}"([^"]+)": \{$/gmu)].map((match) => match[1]),
    ['10', '2', 'a'],
  );
  assert.deepEqual(Object.keys((JSON.parse(text) as { assets: object }).assets).length, 3);
});

test('the manifest is exact two-space JSON with fields in documented order', () => {
  const text = manifestTextOf(HEADER, [
    {
      id: '__proto__',
      asset: assetAt('x.webp', { width: 2, height: 1, locale: 'hu', role: 'actor' }),
    },
  ]);
  const manifest = JSON.parse(text) as { assets: Record<string, ManifestAsset> };
  assert.equal(text, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion',
    'projectId',
    'outputMode',
    'generation',
    'assets',
  ]);
  const entry = Object.getOwnPropertyDescriptor(manifest.assets, '__proto__')
    ?.value as ManifestAsset;
  assert.deepEqual(Object.keys(entry), [
    'url',
    'mediaType',
    'bytes',
    'sha256',
    'width',
    'height',
    'category',
    'role',
    'locale',
    'source',
    'sourceSha256',
  ]);
});

test('optional fields appear only when set, and an empty build has an empty assets object', () => {
  const text = manifestTextOf(HEADER, [{ id: 'voice', asset: assetAt('voice.mp3') }]);
  assert.doesNotMatch(text, /width|height|role|locale/u);
  const empty = JSON.parse(manifestTextOf(HEADER, [])) as { assets: object };
  assert.deepEqual(empty.assets, {});
});
