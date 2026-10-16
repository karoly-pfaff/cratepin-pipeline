import { join } from 'node:path';

import { streamCacheFile } from '../../cache/cache-files.ts';
import { PipelineError, throwIfCancelled } from '../../errors.ts';
import { ensureDirectory, writeNewFile } from '../../paths/files/create-only-files.ts';
import { withContentCheck } from '../../storage/transfer/checked-body.ts';
import { directoriesLeadingTo } from '../../output/files/output-files.ts';
import type { ToolFile } from '../../output/files/output-files.ts';
import type { BuiltAsset } from './asset-outputs.ts';

/** What goes into one staged tree: the outputs and, last, the tool files describing them. */
export interface StagedTree {
  /** An existing, empty, real directory that only this run writes to. */
  readonly directory: string;
  readonly built: readonly BuiltAsset[];
  readonly toolFiles: readonly ToolFile[];
  readonly signal?: AbortSignal | undefined;
}

function stagedMismatch(built: BuiltAsset): PipelineError {
  return new PipelineError(
    'INTEGRITY_MISMATCH',
    'A cached output changed while it was staged; nothing was published.',
    { reason: 'STAGED_FILE_MISMATCH', path: built.outputPath },
  );
}

/** Creates the directories leading to `path` inside `directory`, one at a time, never through a link. */
async function ensureParents(directory: string, path: string): Promise<void> {
  for (const parent of directoriesLeadingTo(path)) {
    await ensureDirectory(join(directory, ...parent.split('/')));
  }
}

async function* textChunks(text: string): AsyncGenerator<Uint8Array> {
  // An async generator must await something; the text is already in memory.
  await Promise.resolve();
  yield Buffer.from(text);
}

async function stageOutput(tree: StagedTree, built: BuiltAsset): Promise<void> {
  throwIfCancelled(tree.signal);
  await ensureParents(tree.directory, built.outputPath);
  const { outputFile, outputSha256, outputBytes } = built.conversion;
  const checked = withContentCheck(
    streamCacheFile(outputFile),
    { sha256: outputSha256, bytes: outputBytes },
    () => stagedMismatch(built),
  );
  await writeNewFile(join(tree.directory, ...built.outputPath.split('/')), checked, tree.signal);
}

/**
 * Writes one complete output tree into an empty staging directory: every output copied from the
 * cache file that holds it (never linked, so an edit in the published tree cannot reach the
 * cache), hashed and counted on the way, each file created new and flushed; then the tool files.
 * A cached output that changed fails with STAGED_FILE_MISMATCH. The caller removes the staging
 * directory when this fails.
 */
export async function stageOutputTree(tree: StagedTree): Promise<void> {
  for (const built of tree.built) await stageOutput(tree, built);
  for (const { name, text } of tree.toolFiles) {
    throwIfCancelled(tree.signal);
    await writeNewFile(join(tree.directory, name), textChunks(text), tree.signal);
  }
}
