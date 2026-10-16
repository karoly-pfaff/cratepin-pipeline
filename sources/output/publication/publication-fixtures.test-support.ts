import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaTypeOf } from '../../catalog/media-types.ts';

import { PipelineError } from '../../errors.ts';
import { GENERATION_LISTING_NAME, listingTextOf } from '../generation/generation-listing.ts';
import { OUTPUT_MARKER_NAME, outputMarkerTextOf } from '../ownership/output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';
import { NODE_PUBLICATION_FILE_SYSTEM } from './publication-files.ts';
import type { PublicationFileSystem } from './publication-files.ts';

/** One operation the publication file system was asked to do. */
export interface FileOperation {
  readonly name: 'rename' | 'mkdir' | 'rmdir' | 'unlink';
  readonly paths: readonly string[];
}

/** Decides whether an operation fails: return the error to throw, or `undefined` to run it. */
export type FailurePlan = (operation: FileOperation, index: number) => Error | undefined;

/** An error as Node reports a file another program holds open on Windows. */
function blockedError(): Error {
  return Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
}

/**
 * The real file system with failures where `plan` says, every operation recorded in order and
 * no real waiting between retries.
 */
export function faultyFileSystem(plan: FailurePlan): {
  readonly fileSystem: PublicationFileSystem;
  readonly operations: FileOperation[];
} {
  const operations: FileOperation[] = [];
  const run = async (operation: FileOperation, real: () => Promise<void>): Promise<void> => {
    operations.push(operation);
    const failure = plan(operation, operations.length - 1);
    if (failure !== undefined) throw failure;
    await real();
  };
  const fileSystem: PublicationFileSystem = {
    rename: (from, to) =>
      run({ name: 'rename', paths: [from, to] }, () =>
        NODE_PUBLICATION_FILE_SYSTEM.rename(from, to),
      ),
    mkdir: (path) =>
      run({ name: 'mkdir', paths: [path] }, () => NODE_PUBLICATION_FILE_SYSTEM.mkdir(path)),
    rmdir: (path) =>
      run({ name: 'rmdir', paths: [path] }, () => NODE_PUBLICATION_FILE_SYSTEM.rmdir(path)),
    unlink: (path) =>
      run({ name: 'unlink', paths: [path] }, () => NODE_PUBLICATION_FILE_SYSTEM.unlink(path)),
    wait: () => Promise.resolve(),
  };
  return { fileSystem, operations };
}

/** Fails every rename whose source ends with `suffix`, as an open file would on Windows. */
export function blockingRenamesFrom(suffix: string): FailurePlan {
  return ({ name, paths }) =>
    name === 'rename' && (paths[0] ?? '').endsWith(suffix) ? blockedError() : undefined;
}

/** Blocks the first `count` operations, then lets every one run. */
export function blockingFirst(count: number): FailurePlan {
  return (_operation, index) => (index < count ? blockedError() : undefined);
}

/** Blocks every operation. */
export function blockingAll(): FailurePlan {
  return () => blockedError();
}

/** Lets every operation run. */
export function failingNone(): FailurePlan {
  return () => undefined;
}

/** The owner the publication tests use. */
export const TEST_OWNER = { projectId: 'demo', outputMode: 'path-preserving' } as const;

/** Writes the files and their listing, as a generation holds them. Returns the directory. */
export async function writeListedTree(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(directory, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(directory, ...path.split('/')), text);
  }
  const listed = Object.entries(files).map(([path, text]) => ({
    path,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    mediaType: mediaTypeOf(path) ?? 'application/octet-stream',
  }));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, GENERATION_LISTING_NAME), listingTextOf(listed));
  return directory;
}

/**
 * Writes a complete tree as a path-preserving build publishes it: the marker, the files, their
 * listing and a manifest. Returns the directory.
 */
export async function writeOwnedTree(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  await writeListedTree(directory, files);
  await writeFile(join(directory, OUTPUT_MARKER_NAME), outputMarkerTextOf(TEST_OWNER));
  await writeFile(join(directory, RUNTIME_MANIFEST_NAME), '{}\n');
  return directory;
}

/** What a refusal must also say: a part of its message and some of its details. */
export interface RefusalDetails {
  readonly messagePart?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Matches a PipelineError with this reason, its message part and these details. */
export function refusedBecause(
  reason: string,
  { messagePart = '', details = {} }: RefusalDetails = {},
): (error: unknown) => boolean {
  return (error) =>
    error instanceof PipelineError &&
    error.details.reason === reason &&
    error.message.includes(messagePart) &&
    Object.entries(details).every(([name, value]) => error.details[name] === value);
}

/** The codes of a result's notices, in order. */
export function noticeCodesOf(result: { readonly notices: readonly { code: string }[] }): string[] {
  return result.notices.map(({ code }) => code);
}
