import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generationDigestOf,
  generationNameOf,
  GENERATION_NAME_LENGTH,
  listingTextOf,
} from './generation-listing.ts';

test('the listing and its digest depend only on the files, never on their order', () => {
  const png = { path: 'b.png', sha256: '1'.repeat(64), bytes: 1, mediaType: 'image/png' };
  const webp = { path: 'a.webp', sha256: '2'.repeat(64), bytes: 2, mediaType: 'image/webp' };
  const files = [png, webp];
  const text = listingTextOf(files);
  assert.equal(listingTextOf(files.toReversed()), text);
  assert.deepEqual(
    (JSON.parse(text) as { files: { path: string }[] }).files.map(({ path }) => path),
    ['a.webp', 'b.png'],
  );
  const digest = generationDigestOf(text);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.notEqual(generationDigestOf(listingTextOf([{ ...png, bytes: 9 }, webp])), digest);
  assert.equal(generationNameOf(digest), digest.slice(0, GENERATION_NAME_LENGTH));
  assert.equal(
    generationNameOf(digest, 1).length,
    1,
    'a shorter name, to force a collision in tests',
  );
});
