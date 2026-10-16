import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { writeFiles } from '../../catalog/source-fixtures.test-support.ts';
import { isRealPathSameOrInside } from '../path-containment.ts';

/** What a hostile layout needs from the volume it runs on, beyond what every volume offers. */
export type VolumeNeed = 'file-symlinks' | 'case-twins';

function systemCodeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** Why file symlinks cannot be made here (no privilege), or `undefined` when they can. */
async function fileSymlinkRefusal(directory: string): Promise<string | undefined> {
  await writeFile(join(directory, 'target'), 'probe');
  try {
    await symlink(join(directory, 'target'), join(directory, 'link'), 'file');
    return undefined;
  } catch (error) {
    if (systemCodeOf(error) !== 'EPERM' && systemCodeOf(error) !== 'EACCES') throw error;
    return 'file symlinks need privileges on this machine';
  }
}

/** Why `Hero.png` and `hero.png` cannot both exist here, or `undefined` when they can. */
async function caseTwinRefusal(directory: string): Promise<string | undefined> {
  await writeFile(join(directory, 'Hero.png'), 'upper');
  try {
    await writeFile(join(directory, 'hero.png'), 'lower', { flag: 'wx' });
    return undefined;
  } catch (error) {
    if (systemCodeOf(error) !== 'EEXIST') throw error;
    return 'case-insensitive volume';
  }
}

const PROBES: Readonly<Record<VolumeNeed, (directory: string) => Promise<string | undefined>>> = {
  'file-symlinks': fileSymlinkRefusal,
  'case-twins': caseTwinRefusal,
};

/**
 * Why a test with this need must be skipped on the temp volume the workspaces live on, found by
 * trying it there (never from the platform's name), or `undefined` when it can run.
 */
export async function skipReasonFor(need: VolumeNeed): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), 'cratepin-probe-'));
  try {
    return await PROBES[need](directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Files a game keeps in its public directory next to the output; no build may touch them. */
const PUBLIC_SENTINELS = {
  'public/index.html': 'the host page',
  'public/other/keep.txt': 'kept by the game',
};

export async function writePublicSentinels(workspace: string): Promise<void> {
  await writeFiles(workspace, PUBLIC_SENTINELS);
}

async function describedEntry(path: string, entry: Dirent): Promise<string> {
  if (entry.isSymbolicLink()) return `link to ${await readlink(path)}`;
  if (entry.isDirectory()) return 'directory';
  if (!entry.isFile()) return 'special entry';
  return `file ${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}

/**
 * Every entry below `workspace` except those at or inside `ownedRoots`, by forward-slash path:
 * each file by its SHA-256, each link or junction by its target (never followed), each directory
 * by its presence. Two equal snapshots mean nothing outside the roots was written, moved or
 * removed.
 */
export async function snapshotOutside(
  workspace: string,
  ownedRoots: readonly string[],
): Promise<Record<string, string>> {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true });
  const paths = entries.map((entry) => ({ entry, path: join(entry.parentPath, entry.name) }));
  const outside = paths.filter(
    ({ path }) => !ownedRoots.some((root) => isRealPathSameOrInside(root, path)),
  );
  const described = await Promise.all(
    outside.map(async ({ entry, path }): Promise<[string, string]> => [
      relative(workspace, path).split(sep).join('/'),
      await describedEntry(path, entry),
    ]),
  );
  return Object.fromEntries(described.toSorted(([left], [right]) => compareCodeUnits(left, right)));
}
