import assert from 'node:assert/strict';
import test from 'node:test';

import type { AssetEntry, MediaCategory } from '../config/pipeline-config.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { catalogSources, derivedIdOf } from './asset-catalog.ts';
import type { SourceCatalog } from './asset-catalog.ts';
import { inventorySources } from './inventory.ts';
import type { InventoryEntry, SourceInventory } from './inventory.ts';
import { checkedProjectIn, sha256Of, writeSources } from './source-fixtures.test-support.ts';

function inventoryOf(paths: readonly string[], category: MediaCategory = 'image'): SourceInventory {
  const entries: InventoryEntry[] = paths.map((path) => ({
    path,
    sha256: sha256Of(path),
    bytes: path.length,
    mediaType: 'image/png',
    category,
  }));
  return { entries, issues: [] };
}

function idsBySource(catalog: SourceCatalog): string[] {
  return catalog.assets.map((asset) => `${asset.path} -> ${asset.id}`);
}

function idsWithCategories(catalog: SourceCatalog): string[] {
  return catalog.assets.map((asset) => `${asset.id} ${asset.category}`);
}

function issueSummary(catalog: SourceCatalog): string[] {
  return catalog.issues.map((issue) => `${issue.code} ${issue.path}`);
}

test('without an authored id the logical ID is the path without its last extension', () => {
  assert.equal(derivedIdOf('images/cat.png'), 'images/cat');
  assert.equal(derivedIdOf('archive.tar.gz'), 'archive.tar');
  assert.equal(derivedIdOf('v1.2/readme'), 'v1.2/readme');
});

test('converting a source to another format keeps its derived logical ID', () => {
  const before = catalogSources(inventoryOf(['images/cat.png']), []);
  const after = catalogSources(inventoryOf(['images/cat.webp']), []);
  assert.deepEqual([before.assets[0]?.id, after.assets[0]?.id], ['images/cat', 'images/cat']);
});

test('an authored id survives a rename once its entry follows the file', () => {
  const authoredBefore: AssetEntry[] = [{ source: 'images/cat.png', id: 'character.cat' }];
  const authoredAfter: AssetEntry[] = [{ source: 'images/kitty.png', id: 'character.cat' }];
  const before = catalogSources(inventoryOf(['images/cat.png']), authoredBefore);
  const after = catalogSources(inventoryOf(['images/kitty.png']), authoredAfter);
  assert.deepEqual(idsBySource(before), ['images/cat.png -> character.cat']);
  assert.deepEqual(idsBySource(after), ['images/kitty.png -> character.cat']);
});

test('an entry left behind by a rename fails instead of silently losing its identity', () => {
  const authored: AssetEntry[] = [{ source: 'images/cat.png', id: 'character.cat' }];
  const catalog = catalogSources(inventoryOf(['images/kitty.png']), authored);
  assert.deepEqual(issueSummary(catalog), ['MISSING_SOURCE /assets/0/source']);
  assert.deepEqual(idsBySource(catalog), ['images/kitty.png -> images/kitty']);
});

test('an entry for a file the inventory rejected is not reported as missing', () => {
  const inventory: SourceInventory = {
    entries: [],
    issues: [{ path: 'images/photo.bmp', code: 'UNSUPPORTED_MEDIA', message: 'unsupported' }],
  };
  const catalog = catalogSources(inventory, [{ source: 'images/photo.bmp', id: 'photo' }]);
  assert.deepEqual(issueSummary(catalog), ['UNSUPPORTED_MEDIA images/photo.bmp']);
});

test('a decomposed file name still gets its logical ID in composed form', () => {
  const catalog = catalogSources(inventoryOf(['images/cafe\u0301.png']), []);
  assert.equal(catalog.assets[0]?.id, 'images/caf\u00e9');
});

test('authored entries match their file ignoring letter case and carry metadata', () => {
  const catalog = catalogSources(inventoryOf(['voice/hu/Hello.png']), [
    {
      source: 'voice/hu/hello.png',
      locale: 'hu',
      role: 'greeting',
      profile: 'copy',
      licence: 'CC-BY-4.0',
    },
  ]);
  assert.deepEqual(catalog.issues, []);
  assert.deepEqual(catalog.assets, [
    {
      path: 'voice/hu/Hello.png',
      sha256: sha256Of('voice/hu/Hello.png'),
      bytes: 'voice/hu/Hello.png'.length,
      mediaType: 'image/png',
      category: 'image',
      id: 'voice/hu/Hello',
      locale: 'hu',
      role: 'greeting',
      profile: 'copy',
      licence: 'CC-BY-4.0',
    },
  ]);
});

test('IDs that would collide, also by letter case or with an authored id, fail', () => {
  const catalog = catalogSources(inventoryOf(['a/cat.png', 'a/cat.webp', 'b/Dog.png', 'c.png']), [
    { source: 'c.png', id: 'b/dog' },
  ]);
  assert.deepEqual(issueSummary(catalog), [
    'DUPLICATE_ID a/cat.png',
    'DUPLICATE_ID a/cat.webp',
    'DUPLICATE_ID b/Dog.png',
    'DUPLICATE_ID c.png',
  ]);
  assert.match(catalog.issues[0]?.message ?? '', /Group: a\/cat\.png, a\/cat\.webp\./);
});

test('a derived ID that is not portable asks for an authored id', () => {
  const catalog = catalogSources(inventoryOf(['images/hero .png']), []);
  assert.deepEqual(issueSummary(catalog), ['INVALID_ID images/hero .png']);
  assert.deepEqual(catalog.assets, []);
});

test('assets are sorted by logical ID, not by path', () => {
  const catalog = catalogSources(inventoryOf(['a.png', 'b.png']), [{ source: 'a.png', id: 'z' }]);
  assert.deepEqual(idsBySource(catalog), ['b.png -> b', 'a.png -> z']);
});

test('an authored category replaces the rules and must still suit the format', async () => {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, { 'ui/click.mp3': 'click', 'ui/icon.png': 'icon' });
    const project = await checkedProjectIn(workspace, {
      assets: [
        { source: 'UI/Click.mp3', category: 'effects' },
        { source: 'ui/icon.png', category: 'voice' },
      ],
    });
    const catalog = catalogSources(await inventorySources(project), project.config.assets);
    assert.deepEqual(idsWithCategories(catalog), ['ui/click effects']);
    assert.ok(issueSummary(catalog).includes('CATEGORY_MISMATCH ui/icon.png'));
  });
});

test('game JSON is an opaque file: its references are not followed or rewritten', async () => {
  await withWorkspace(async (workspace) => {
    const sceneJson = JSON.stringify({ background: 'images/missing.png' });
    await writeSources(workspace, { 'scenes/forest/scene.json': sceneJson });
    const project = await checkedProjectIn(workspace, { sources: { include: ['**/*.json'] } });
    const catalog = catalogSources(await inventorySources(project), []);
    assert.deepEqual(catalog.issues, []);
    assert.deepEqual(catalog.assets[0], {
      path: 'scenes/forest/scene.json',
      sha256: sha256Of(sceneJson),
      bytes: sceneJson.length,
      mediaType: 'application/json',
      category: 'other',
      id: 'scenes/forest/scene',
    });
  });
});
