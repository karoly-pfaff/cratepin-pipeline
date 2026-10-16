import assert from 'node:assert/strict';
import test from 'node:test';

import { mediaTypeOf, suitsCategory } from './media-types.ts';

test('the media type follows the last extension in any letter case', () => {
  assert.equal(mediaTypeOf('images/cat.PNG'), 'image/png');
  assert.equal(mediaTypeOf('music/theme.final.ogg'), 'audio/ogg');
  assert.equal(mediaTypeOf('images.png/readme'), undefined);
  assert.equal(mediaTypeOf('images/.png'), undefined);
  assert.equal(mediaTypeOf('images/cat.bmp'), undefined);
});

test('categories accept only formats that suit them', () => {
  assert.ok(suitsCategory('image', 'image/png'));
  assert.ok(suitsCategory('voice', 'audio/mpeg'));
  assert.ok(!suitsCategory('music', 'image/png'));
  assert.ok(!suitsCategory('image', 'audio/mpeg'));
  assert.ok(suitsCategory('other', 'font/woff2'));
});
