import { toPipelineError } from '../errors.ts';
import { parseStrictJson } from '../json/strict-json.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { validateLock } from './lock-validation.ts';
import type { LockIssue } from './lock-validation.ts';
import type { SourceLock } from './source-lock.ts';
import { readTextWithin } from '../paths/files/bounded-text.ts';

/**
 * The committed lock: not created yet, valid, or invalid. Validation runs in stages (JSON, shape,
 * relations), so issues of a later stage appear once the earlier ones are fixed.
 */
export type LockLoad =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly lock: SourceLock }
  | { readonly status: 'invalid'; readonly issues: readonly LockIssue[] };

/** A lock larger than this was not written by this tool for any realistic project. */
const MAX_LOCK_BYTES = 64 * 1024 * 1024;

const OVERSIZED_LOCK = {
  path: '/',
  code: 'LOCK_INVALID' as const,
  message: `Larger than ${String(MAX_LOCK_BYTES / 1024 / 1024)} MiB; not a lock this tool wrote`,
};

/** The lock file's text, or why there is none: it is absent or larger than a lock can be. */
type LockText =
  | { readonly state: 'present'; readonly text: string }
  | { readonly state: 'absent' }
  | { readonly state: 'oversized' };

/** Other read errors than a missing file propagate. */
async function readLockText(path: string): Promise<LockText> {
  try {
    const text = await readTextWithin(path, MAX_LOCK_BYTES);
    return text === undefined ? { state: 'oversized' } : { state: 'present', text };
  } catch (error) {
    if (toPipelineError(error).code === 'NOT_FOUND') return { state: 'absent' };
    throw error;
  }
}

/** Parses and validates the lock text for this project. */
function lockLoadOf(text: string, project: CheckedProject): LockLoad {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    const issues = parsed.problems.map((problem) => ({
      ...problem,
      code: 'LOCK_INVALID' as const,
    }));
    return { status: 'invalid', issues };
  }
  const validation = validateLock(parsed.value, project.config);
  return validation.ok
    ? { status: 'valid', lock: validation.lock }
    : { status: 'invalid', issues: validation.issues };
}

/** Reads and validates the project's committed lock file; reads only. */
export async function loadCommittedLock(project: CheckedProject): Promise<LockLoad> {
  const read = await readLockText(project.paths.lockFilePath);
  if (read.state === 'absent') return { status: 'absent' };
  if (read.state === 'oversized') return { status: 'invalid', issues: [OVERSIZED_LOCK] };
  return lockLoadOf(read.text, project);
}
