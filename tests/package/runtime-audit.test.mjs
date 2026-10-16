import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withTempDirectory } from '../support/cli-runs.test-support.mjs';
import { auditRuntimeTree, RUNTIME_MARKERS } from './runtime-audit.test-support.mjs';

function pathsOf(inventory) {
  return inventory.map((file) => file.path);
}

function markersOf(inventory) {
  return inventory.map((file) => file.markers);
}

function defaultMarkerLabels() {
  return RUNTIME_MARKERS.map((_marker, index) => `marker-${index + 1}`).toSorted();
}

test('every default storage and credential marker is detected', async () => {
  await withTempDirectory(async (root) => {
    await writeFile(join(root, 'runtime.bin'), RUNTIME_MARKERS.join('\n'));
    assert.deepEqual((await auditRuntimeTree(root))[0].markers, defaultMarkerLabels());
  });
});

test('runtime inventory hashes every file and preserves nested portable paths', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(join(root, 'media', 'nested'), { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 0, 10]);
    await writeFile(join(root, 'media', 'nested', 'image.bin'), bytes);
    await writeFile(join(root, 'index.html'), 'local-only');
    const inventory = await auditRuntimeTree(root);
    assert.deepEqual(pathsOf(inventory), ['index.html', 'media/nested/image.bin']);
    assert.deepEqual(inventory[1], {
      path: 'media/nested/image.bin',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      markers: [],
    });
  });
});

test('binary canaries straddling stream chunks are found and values are never reported', async () => {
  await withTempDirectory(async (root) => {
    const canary = 'private-audit-canary';
    const bytes = Buffer.concat([
      Buffer.alloc(65_530, 255),
      Buffer.from(canary.toUpperCase()),
      Buffer.alloc(90_000),
    ]);
    await writeFile(join(root, 'audio.mp3'), bytes);
    const inventory = await auditRuntimeTree(root, [canary]);
    assert.deepEqual(inventory[0].markers, ['marker-1']);
    assert.equal(inventory[0].bytes, bytes.length);
    assert.ok(!JSON.stringify(inventory).includes(canary));
  });
});

test('signed URL and UTF-16 credential references are found without text extension filtering', async () => {
  await withTempDirectory(async (root) => {
    await writeFile(join(root, 'data.bin'), Buffer.from('R2_READ_SECRET_ACCESS_KEY', 'utf16le'));
    await writeFile(join(root, 'bundle.js'), 'https://store.invalid/object?x-AmZ-sIgNaTuRe=hidden');
    const inventory = await auditRuntimeTree(root);
    assert.deepEqual(markersOf(inventory), [['marker-5'], ['marker-2']]);
  });
});

test('an audit refuses directory links instead of silently skipping their files', async () => {
  await withTempDirectory(async (root) => {
    await mkdir(join(root, 'real'));
    await symlink(
      join(root, 'real'),
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(auditRuntimeTree(root), /refuses links/u);
    await assert.rejects(auditRuntimeTree(join(root, 'linked')), /real directory/u);
  });
});

test('missing roots and empty markers fail the audit', async () => {
  await withTempDirectory(async (root) => {
    await assert.rejects(auditRuntimeTree(join(root, 'missing')), { code: 'ENOENT' });
    await assert.rejects(auditRuntimeTree(root, ['']), /Empty audit marker/u);
  });
});
