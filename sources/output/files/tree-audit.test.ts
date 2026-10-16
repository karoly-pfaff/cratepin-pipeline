import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { sha256Of } from '../../catalog/source-fixtures.test-support.ts';
import { linkDirectory, withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { auditOutputTree } from './tree-audit.ts';
import type { AuditFinding, TreeExpectation } from './tree-audit.ts';

const CAT = Buffer.from('cat pixels');
const VOICE = Buffer.from('voice line');

const EXPECTED: TreeExpectation = {
  files: [
    { path: 'images/cat.png', sha256: sha256Of(CAT), bytes: CAT.length, mediaType: 'image/png' },
    {
      path: 'voice/hu/hello.mp3',
      sha256: sha256Of(VOICE),
      bytes: VOICE.length,
      mediaType: 'audio/mpeg',
    },
  ],
  toolFiles: [{ name: 'cratepin-manifest.json', text: '{}\n' }],
};

/** A tree holding exactly the expected outputs and tool file. */
async function completeTree(workspace: string): Promise<string> {
  const root = join(workspace, 'tree');
  await mkdir(join(root, 'images'), { recursive: true });
  await mkdir(join(root, 'voice', 'hu'), { recursive: true });
  await writeFile(join(root, 'images', 'cat.png'), CAT);
  await writeFile(join(root, 'voice', 'hu', 'hello.mp3'), VOICE);
  await writeFile(join(root, 'cratepin-manifest.json'), '{}\n');
  return root;
}

function codesAndPaths(findings: readonly AuditFinding[]): string[] {
  return findings.map(({ code, path }) => `${code} ${path}`);
}

async function findingsAfter(
  change: (root: string, workspace: string) => Promise<void>,
): Promise<string[]> {
  let findings: string[] = [];
  await withWorkspace(async (workspace) => {
    const root = await completeTree(workspace);
    await change(root, workspace);
    findings = codesAndPaths(await auditOutputTree(root, EXPECTED));
  });
  return findings;
}

async function unchanged(): Promise<void> {
  // The complete tree as written.
}

test('a complete tree has no findings', async () => {
  assert.deepEqual(await findingsAfter(unchanged), []);
});

test('an extra file, an empty directory or a link is not the tool’s', async () => {
  assert.deepEqual(
    await findingsAfter(async (root, workspace) => {
      await writeFile(join(root, 'images', 'Thumbs.db'), 'x');
      await mkdir(join(root, 'empty'));
      await mkdir(join(workspace, 'elsewhere'));
      await linkDirectory(join(workspace, 'elsewhere'), join(root, 'linked'));
    }),
    [
      'UNLISTED_OUTPUT_ENTRY empty',
      'UNLISTED_OUTPUT_ENTRY images/Thumbs.db',
      'UNLISTED_OUTPUT_ENTRY linked',
    ],
  );
});

test('a missing output, changed bytes and a changed tool file are found', async () => {
  assert.deepEqual(
    await findingsAfter(async (root) => {
      await rm(join(root, 'voice', 'hu', 'hello.mp3'));
      await writeFile(join(root, 'images', 'cat.png'), 'cat pixelz');
      await writeFile(join(root, 'cratepin-manifest.json'), '{ }\n');
    }),
    [
      'OUTPUT_MISMATCH cratepin-manifest.json',
      'OUTPUT_MISMATCH images/cat.png',
      'OUTPUT_MISSING voice/hu/hello.mp3',
    ],
  );
});

test('an output whose name does not say its media type is wrong', async () => {
  await withWorkspace(async (workspace) => {
    const root = await completeTree(workspace);
    const [cat, voice] = EXPECTED.files;
    assert.ok(cat !== undefined && voice !== undefined);
    const wrongType = { ...EXPECTED, files: [{ ...cat, mediaType: 'image/webp' }, voice] };
    const findings = await auditOutputTree(root, wrongType);
    assert.deepEqual(codesAndPaths(findings), ['OUTPUT_MISMATCH images/cat.png']);
    assert.match(findings[0]?.message ?? '', /image\/webp/u);
  });
});

test('a directory where an output file belongs is not that output', async () => {
  assert.deepEqual(
    await findingsAfter(async (root) => {
      await rm(join(root, 'images', 'cat.png'));
      await mkdir(join(root, 'images', 'cat.png'));
    }),
    ['OUTPUT_MISMATCH images/cat.png', 'UNLISTED_OUTPUT_ENTRY images/cat.png'],
  );
});
