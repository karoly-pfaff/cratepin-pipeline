import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { pngOf, transparentArtwork } from '../../media/testing/media-fixtures.test-support.ts';
import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { hasContentOf } from './content-sniff.ts';

async function fileWith(
  workspace: string,
  name: string,
  bytes: Uint8Array | string,
): Promise<string> {
  const path = join(workspace, name);
  await writeFile(path, bytes);
  return path;
}

test('an image is what its media type says only when its leading bytes agree', async () => {
  await withWorkspace(async (workspace) => {
    const png = await fileWith(workspace, 'a.png', await pngOf(transparentArtwork(2, 2)));
    assert.equal(await hasContentOf(png, 'image/png'), true);
    assert.equal(await hasContentOf(png, 'image/webp'), false, 'PNG bytes under a WebP name');
    const webp = await fileWith(
      workspace,
      'b.webp',
      Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'),
    );
    assert.equal(await hasContentOf(webp, 'image/webp'), true);
    const gif = await fileWith(workspace, 'c.gif', 'GIF89a......');
    assert.equal(await hasContentOf(gif, 'image/gif'), true);
    const jpeg = await fileWith(workspace, 'd.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.equal(await hasContentOf(jpeg, 'image/jpeg'), true);
    const short = await fileWith(workspace, 'e.png', 'PN');
    assert.equal(await hasContentOf(short, 'image/png'), false);
  });
});

test('media types the tool does not sniff always pass', async () => {
  await withWorkspace(async (workspace) => {
    const voice = await fileWith(workspace, 'hello.mp3', 'not even audio');
    assert.equal(await hasContentOf(voice, 'audio/mpeg'), true);
  });
});
