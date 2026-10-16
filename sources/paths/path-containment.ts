import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { PipelineError } from '../errors.ts';
import { caseFoldedPath } from './portable-path.ts';

export type EntryKind = 'absent' | 'directory' | 'file' | 'symbolic-link' | 'other' | 'unreadable';

/** Only "no such entry" means absent; permission and other errors must never look like "free". */
const ABSENT_ENTRY_CODES = new Set(['ENOENT', 'ENOTDIR']);

export function isAbsentEntryError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ABSENT_ENTRY_CODES.has(code);
}

/** The kind of the entry at `path` itself, without following a final symbolic link. */
export async function entryKindAt(path: string): Promise<EntryKind> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return 'symbolic-link';
    if (entry.isDirectory()) return 'directory';
    return entry.isFile() ? 'file' : 'other';
  } catch (error) {
    return isAbsentEntryError(error) ? 'absent' : 'unreadable';
  }
}

/**
 * Where `target` really is on disk: the real path of its nearest existing ancestor (resolving
 * every symbolic link and Windows junction on the way) joined with the not-yet-existing rest.
 * An ancestor that cannot be inspected stops the walk, so an unseen link is never skipped.
 */
export async function resolveRealLocation(target: string): Promise<string> {
  const ancestor = await nearestExistingAncestor(target);
  if (ancestor.kind === 'unreadable') {
    throw new PipelineError('IO_FAILED', 'A parent directory cannot be inspected.');
  }
  return join(await realpath(ancestor.path), ...ancestor.missingSegments);
}

interface ExistingAncestor {
  readonly path: string;
  readonly kind: EntryKind;
  readonly missingSegments: readonly string[];
}

/** Climbs from `target` until an entry exists or cannot be inspected, collecting what is missing. */
async function nearestExistingAncestor(target: string): Promise<ExistingAncestor> {
  const missingSegments: string[] = [];
  let path = target;
  let kind = await entryKindAt(path);
  while (kind === 'absent' && dirname(path) !== path) {
    missingSegments.unshift(basename(path));
    path = dirname(path);
    kind = await entryKindAt(path);
  }
  return { path, kind, missingSegments };
}

/** `dev:ino` of an existing file, following links; equal identities mean one file (hard links). */
export async function fileIdentityOf(path: string): Promise<string | undefined> {
  try {
    const { dev, ino } = await stat(path, { bigint: true });
    return `${String(dev)}:${String(ino)}`;
  } catch {
    return undefined;
  }
}

/**
 * True when `childRealPath` is `parentRealPath` or below it. Both must come from `realpath`,
 * which returns the file system's own spelling, so they are compared exactly: NTFS and
 * case-sensitive volumes treat `K` (Kelvin sign) and `k`, or NFC and NFD forms, as different
 * names, and folding them would accept a sibling directory as "inside".
 */
export function isRealPathSameOrInside(parentRealPath: string, childRealPath: string): boolean {
  const parentPrefix = parentRealPath.endsWith(sep) ? parentRealPath : `${parentRealPath}${sep}`;
  return childRealPath === parentRealPath || childRealPath.startsWith(parentPrefix);
}

function isRelationSameOrInside(relation: string): boolean {
  const leavesParent = relation === '..' || relation.startsWith(`..${sep}`);
  return relation === '' || (!leavesParent && !isAbsolute(relation));
}

/** Conservative containment ignoring letter case, for checks that must hold on every platform. */
export function couldContainOnAnyPlatform(parent: string, child: string): boolean {
  return isRelationSameOrInside(relative(caseFoldedPath(parent), caseFoldedPath(child)));
}

/**
 * True when one path is, or lies below, the other once letter case is ignored: roots that could
 * overlap on a case-insensitive volume are rejected everywhere.
 */
export function couldOverlapOnAnyPlatform(first: string, second: string): boolean {
  return couldContainOnAnyPlatform(first, second) || couldContainOnAnyPlatform(second, first);
}
