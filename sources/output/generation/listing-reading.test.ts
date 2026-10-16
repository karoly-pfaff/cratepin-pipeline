import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { GENERATION_LISTING_NAME, listingTextOf } from './generation-listing.ts';
import { readGenerationListing } from './listing-reading.ts';

const SHA = 'a'.repeat(64);

function listingWith(path: unknown): string {
  return JSON.stringify({
    schemaVersion: 1,
    files: [{ path, sha256: SHA, bytes: 3, mediaType: 'image/png' }],
  });
}

async function readListingText(workspace: string, text: string) {
  await writeFile(join(workspace, GENERATION_LISTING_NAME), text);
  return readGenerationListing(workspace);
}

test('a listing the tool wrote is read back with its exact text', async () => {
  await withWorkspace(async (workspace) => {
    const text = listingTextOf([
      { path: 'images/cat.png', sha256: SHA, bytes: 3, mediaType: 'image/png' },
    ]);
    const listing = await readListingText(workspace, text);
    assert.equal(listing?.text, text);
    assert.deepEqual(listing.files, [
      { path: 'images/cat.png', sha256: SHA, bytes: 3, mediaType: 'image/png' },
    ]);
  });
});

test('a missing listing, or anything that is not one, is not trusted', async () => {
  await withWorkspace(async (workspace) => {
    assert.equal(await readGenerationListing(workspace), undefined, 'missing');
    const refused = ['not json', '{"schemaVersion":2,"files":[]}', '{"schemaVersion":1}', '[]'];
    for (const text of refused) {
      assert.equal(await readListingText(workspace, text), undefined, text);
    }
  });
});

test('a listed path that could leave the tree makes the whole listing untrusted', async () => {
  await withWorkspace(async (workspace) => {
    for (const path of ['../outside.png', '/abs.png', 'C:/abs.png', 'a\\b.png', 'a//b.png', 7]) {
      assert.equal(await readListingText(workspace, listingWith(path)), undefined, String(path));
    }
    assert.notEqual(await readListingText(workspace, listingWith('a/b.png')), undefined);
  });
});
