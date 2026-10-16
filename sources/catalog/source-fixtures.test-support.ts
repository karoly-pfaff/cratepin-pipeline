import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadCheckedProject } from '../paths/layout/checked-project.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';

/** Writes `files` (forward-slash paths relative to `directory`) and returns `directory`. */
export async function writeFiles(
  directory: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(directory, ...path.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return directory;
}

/** Writes `files` into the default source directory `assets/source` and returns its path. */
export function writeSources(
  workspace: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<string> {
  return writeFiles(join(workspace, 'assets', 'source'), files);
}

/** A preflighted project in `workspace`; `config` overrides the minimal valid configuration. */
export async function checkedProjectIn(
  workspace: string,
  config: object = {},
): Promise<CheckedProject> {
  const configFile = join(workspace, 'cratepin.config.json');
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, projectId: 'demo', ...config }));
  const load = await loadCheckedProject(configFile);
  if (!load.ok) throw new Error(`Fixture config is invalid: ${JSON.stringify(load.issues)}`);
  return load.project;
}

export function sha256Of(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** True when this process can be denied access to its own files (not as root on POSIX). */
export function canDenyAccess(): boolean {
  return process.platform === 'win32' || process.getuid?.() !== 0;
}

/** What is denied: reading a file's content, or creating files in a directory. */
type DeniedAccess = 'read' | 'create';

const POSIX_DENIED_MODES: Readonly<Record<DeniedAccess, number>> = { read: 0o000, create: 0o500 };
/** "Read data / list directory" or "create files / write data"; attributes stay readable. */
const WINDOWS_DENIED_RIGHTS: Readonly<Record<DeniedAccess, string>> = { read: 'RD', create: 'WD' };

async function setAccessDenied(
  path: string,
  access: DeniedAccess,
  isDenied: boolean,
): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(path, isDenied ? POSIX_DENIED_MODES[access] : 0o700);
    return;
  }
  const right = WINDOWS_DENIED_RIGHTS[access];
  const change = isDenied ? ['/deny', `*S-1-1-0:(${right})`] : ['/remove:d', '*S-1-1-0'];
  const icacls = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'icacls.exe');
  execFileSync(icacls, [path, ...change]);
}

async function withAccessDenied<Result>(
  paths: readonly string[],
  access: DeniedAccess,
  useDenied: () => Promise<Result>,
): Promise<Result> {
  for (const path of paths) await setAccessDenied(path, access, true);
  try {
    return await useDenied();
  } finally {
    for (const path of paths) await setAccessDenied(path, access, false);
  }
}

/** Runs `useDenied` while the content of `paths` cannot be read, then restores access. */
export function withReadDenied<Result>(
  paths: readonly string[],
  useDenied: () => Promise<Result>,
): Promise<Result> {
  return withAccessDenied(paths, 'read', useDenied);
}

/** Runs `useDenied` while nothing can be created in the directories `paths`, then restores access. */
export function withWriteDenied<Result>(
  paths: readonly string[],
  useDenied: () => Promise<Result>,
): Promise<Result> {
  return withAccessDenied(paths, 'create', useDenied);
}
