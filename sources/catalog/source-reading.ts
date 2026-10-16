import { lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { hashOpenedFile } from '../opened-file-hash.ts';
import { openSourceFile } from '../paths/files/source-file-opening.ts';
import type { InventoryEntry } from './inventory.ts';
import { accept, outcomeOf, reject, sourceIssue, unreadableIssue } from './source-issues.ts';
import type { Checked, CheckOutcome } from './source-issues.ts';
import type { SourceCandidate } from './source-selection.ts';

/**
 * Hashes an opened candidate, reading at most one byte more than the limit: the file can grow
 * between the size check and the read, so the bytes actually read decide.
 */
export async function hashOpenedWithinLimit(
  file: FileHandle,
  candidate: SourceCandidate,
  maxSourceBytes: number,
): Promise<Checked<InventoryEntry>> {
  const digest = await hashOpenedFile(file, maxSourceBytes + 1);
  if (digest.bytes > maxSourceBytes) return reject(sourceIssue(candidate.path, 'SOURCE_TOO_LARGE'));
  return accept({ ...candidate, sha256: digest.sha256, bytes: digest.bytes });
}

/**
 * Checks type and size without reading (so an oversized file is never opened), then opens the
 * file once and hashes from that handle. Read errors propagate.
 */
async function hashWithinLimit(
  candidate: SourceCandidate,
  absolutePath: string,
  maxSourceBytes: number,
): Promise<Checked<InventoryEntry>> {
  const fileStats = await lstat(absolutePath);
  if (!fileStats.isFile()) return reject(sourceIssue(candidate.path, 'NOT_A_REGULAR_FILE'));
  if (fileStats.size > maxSourceBytes)
    return reject(sourceIssue(candidate.path, 'SOURCE_TOO_LARGE'));
  const file = await openSourceFile(absolutePath);
  try {
    return await hashOpenedWithinLimit(file, candidate, maxSourceBytes);
  } finally {
    await file.close();
  }
}

/** The candidate's entry, or an issue; a file that vanished or may not be read is UNREADABLE. */
async function inventoryEntryOrIssue(
  candidate: SourceCandidate,
  sourceRoot: string,
  maxSourceBytes: number,
): Promise<Checked<InventoryEntry>> {
  try {
    const absolutePath = join(sourceRoot, ...candidate.path.split('/'));
    return await hashWithinLimit(candidate, absolutePath, maxSourceBytes);
  } catch (error) {
    return reject(unreadableIssue(candidate.path, error));
  }
}

/**
 * Hashes the candidates one at a time as streams, so memory stays flat even for large originals.
 * Hashing is sequential: it is bound by the disk, and `limits.concurrency` governs transfers.
 */
export async function readCandidates(
  candidates: readonly SourceCandidate[],
  sourceRoot: string,
  maxSourceBytes: number,
): Promise<CheckOutcome<InventoryEntry>> {
  const results: Checked<InventoryEntry>[] = [];
  for (const candidate of candidates) {
    results.push(await inventoryEntryOrIssue(candidate, sourceRoot, maxSourceBytes));
  }
  return outcomeOf(results);
}
