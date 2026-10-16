import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Directory links that need no elevated rights: junctions on Windows, symlinks elsewhere. */
export async function linkDirectory(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Runs `useWorkspace` in a fresh real temp directory and removes it afterwards. */
export async function withWorkspace(
  useWorkspace: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'cratepin-layout-')));
  try {
    await useWorkspace(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
