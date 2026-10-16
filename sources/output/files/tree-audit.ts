import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { mediaTypeOf } from '../../catalog/media-types.ts';
import { compareCodeUnits } from '../../catalog/ordering.ts';
import { mapBounded } from '../../storage/transfer/bounded-tasks.ts';
import type { ListedFile } from '../generation/generation-listing.ts';
import { checkOutputFile, directoriesLeadingTo, readOutputFile } from './output-files.ts';
import type { ToolFile } from './output-files.ts';

/** Files hashed at the same time; every one holds an open handle until it is hashed. */
const AUDIT_CONCURRENCY = 16;

/** What one output tree must hold, and nothing else. */
export interface TreeExpectation {
  readonly files: readonly ListedFile[];
  /** Tool files at the top of the tree that must hold exactly their text. */
  readonly toolFiles: readonly ToolFile[];
}

/** One way a tree differs from what it must hold. */
export interface AuditFinding {
  readonly path: string;
  readonly code: 'OUTPUT_MISSING' | 'OUTPUT_MISMATCH' | 'UNLISTED_OUTPUT_ENTRY';
  readonly message: string;
}

/** What a no-follow walk found: regular files, real directories, and everything else. */
export interface WalkedTree {
  readonly files: string[];
  readonly directories: string[];
  readonly others: string[];
}

/** The list an entry belongs in: real directories, regular files, or everything else. */
function listForKindOf(found: WalkedTree, entry: Dirent): string[] {
  if (entry.isDirectory()) return found.directories;
  return entry.isFile() ? found.files : found.others;
}

async function walk(root: string, prefix: string, found: WalkedTree): Promise<void> {
  const directory = prefix === '' ? root : join(root, ...prefix.split('/'));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    listForKindOf(found, entry).push(path);
    if (entry.isDirectory()) await walk(root, path, found);
  }
}

/** Lists the tree without following any link or junction; those count as foreign entries. */
export async function walkTree(root: string): Promise<WalkedTree> {
  const found: WalkedTree = { files: [], directories: [], others: [] };
  await walk(root, '', found);
  return found;
}

function finding(path: string, code: AuditFinding['code'], message: string): AuditFinding {
  return { path, code, message };
}

/**
 * The entries of a walked tree the tool did not write: files not expected, every link or other
 * special entry, and directories that lead to no expected file.
 */
export function unlistedPathsOf(walked: WalkedTree, expectedPaths: ReadonlySet<string>): string[] {
  const neededDirectories = new Set([...expectedPaths].flatMap(directoriesLeadingTo));
  return [
    ...walked.files.filter((path) => !expectedPaths.has(path)),
    ...walked.others,
    ...walked.directories.filter((path) => !neededDirectories.has(path)),
  ];
}

/** Entries the tree must not have: unexpected files, links, and directories leading nowhere. */
function unlistedFindings(walked: WalkedTree, expectedPaths: ReadonlySet<string>): AuditFinding[] {
  return unlistedPathsOf(walked, expectedPaths).map((path) =>
    finding(path, 'UNLISTED_OUTPUT_ENTRY', 'The tool did not write this entry.'),
  );
}

async function fileFindings(root: string, file: ListedFile): Promise<AuditFinding[]> {
  const state = await checkOutputFile(join(root, ...file.path.split('/')), file);
  if (state === 'absent') return [finding(file.path, 'OUTPUT_MISSING', 'The output is missing.')];
  const mismatches = [
    ...(state === 'verified' ? [] : ['its bytes are not the listed ones']),
    ...(mediaTypeOf(file.path) === file.mediaType
      ? []
      : [`its name does not say ${file.mediaType}`]),
  ];
  return mismatches.map((what) =>
    finding(file.path, 'OUTPUT_MISMATCH', `The output is wrong: ${what}.`),
  );
}

async function textFindings(root: string, { name, text }: ToolFile): Promise<AuditFinding[]> {
  const expected = Buffer.from(text);
  const reading = await readOutputFile(join(root, name), expected.length);
  if (reading.state === 'absent') return [finding(name, 'OUTPUT_MISSING', 'The file is missing.')];
  const isExact = reading.state === 'present' && expected.equals(reading.bytes);
  return isExact
    ? []
    : [finding(name, 'OUTPUT_MISMATCH', 'The file does not hold the expected text.')];
}

/**
 * Compares a tree with what it must hold, reading every byte: each listed output is a regular
 * file with exactly its listed size and SHA-256 and a name whose extension says its media type,
 * each tool file holds exactly its text, and nothing else is there (no other file, no link or
 * junction, no directory that leads to no output). Changes nothing.
 */
export async function auditOutputTree(
  root: string,
  expected: TreeExpectation,
): Promise<AuditFinding[]> {
  const walked = await walkTree(root);
  const expectedPaths = new Set([
    ...expected.files.map((file) => file.path),
    ...expected.toolFiles.map((file) => file.name),
  ]);
  const findings = [
    ...unlistedFindings(walked, expectedPaths),
    ...(
      await mapBounded(expected.files, AUDIT_CONCURRENCY, (file) => fileFindings(root, file))
    ).flat(),
    ...(
      await mapBounded(expected.toolFiles, AUDIT_CONCURRENCY, (file) => textFindings(root, file))
    ).flat(),
  ];
  return findings.toSorted(
    (left, right) =>
      compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code),
  );
}
