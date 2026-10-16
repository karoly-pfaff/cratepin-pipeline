import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { ensureDirectory } from '../../paths/files/create-only-files.ts';
import type { ReportIssue } from '../../report.ts';
import { generationTrashPathOf } from './generation-layout.ts';
import { isGenerationAt } from './generation-root.ts';
import type { GenerationLayout } from './generation-layout.ts';
import { renameWithRetry } from '../publication/publication-files.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';
import { removeEmptyTrash, removeTrashedTrees } from '../files/trash-removal.ts';
import { GENERATION_TOOL_FILE_NAMES, keptPathNotices } from '../files/tree-removal.ts';

/** Which generations stay: by directory name, the one just published and the one it replaced. */
export interface RetentionRequest {
  readonly fileSystem: PublicationFileSystem;
  readonly layout: GenerationLayout;
  readonly keptNames: ReadonlySet<string>;
}

/** What retention did: the generations it retired, the files removed, what stayed. */
export interface Retention {
  readonly retiredGenerations: readonly string[];
  readonly removedFileCount: number;
  readonly notices: readonly ReportIssue[];
}

/** Generations that are not kept: real directories with a generation's name and listing. */
async function retirableGenerations({ layout, keptNames }: RetentionRequest): Promise<string[]> {
  const names = await readdir(layout.generations).catch((): string[] => []);
  const retirable: string[] = [];
  for (const name of names.toSorted(compareCodeUnits)) {
    const isRetirable = !keptNames.has(name) && (await isGenerationAt(layout, name));
    if (isRetirable) retirable.push(name);
  }
  return retirable;
}

function generationKeptNotice(path: string): ReportIssue {
  return {
    path,
    code: 'GENERATION_KEPT',
    message:
      'An old generation could not be moved to the trash (a file in it is open, or the trash is not a real directory); it stays whole until a later build that publishes retires it.',
  };
}

/** Moves one old generation to the trash, whole; false when it stays (an open file, a bad trash). */
async function trashGeneration(request: RetentionRequest, name: string): Promise<boolean> {
  const { fileSystem, layout } = request;
  try {
    await ensureDirectory(layout.trash);
    await renameWithRetry(
      fileSystem,
      join(layout.generations, name),
      generationTrashPathOf(layout),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * After a manifest switch, retires every generation but the kept ones: each moves whole to the
 * trash (one with an open file stays whole, GENERATION_KEPT), then everything in the trash is
 * removed file by file as its listing proves it, never through a link. Never fails a build.
 */
export async function retireGenerations(request: RetentionRequest): Promise<Retention> {
  const retiredGenerations: string[] = [];
  const notices: ReportIssue[] = [];
  for (const name of await retirableGenerations(request)) {
    if (await trashGeneration(request, name)) retiredGenerations.push(name);
    else notices.push(generationKeptNotice(join(request.layout.generations, name)));
  }
  const cleanup = await removeTrashedTrees(
    request.fileSystem,
    request.layout.trash,
    GENERATION_TOOL_FILE_NAMES,
  );
  await removeEmptyTrash(request.fileSystem, request.layout.trash);
  return {
    retiredGenerations,
    removedFileCount: cleanup.removedFileCount,
    notices: [...notices, ...keptPathNotices(cleanup.keptPaths)],
  };
}
