import { writeFile } from 'node:fs/promises';

import { isJsonObject } from '../../json/strict-json.ts';
import { isSha256Hex } from '../../lock/lock-validation.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import type { GenerationLayout } from '../generation/generation-layout.ts';
import { RUNTIME_MANIFEST_SCHEMA_VERSION } from '../../contracts.ts';
import { publishedAssetsOf } from './manifest-reading.ts';
import type { OutputOwner } from '../ownership/output-marker.ts';
import { MAX_TOOL_JSON_BYTES, readToolJson } from '../files/output-files.ts';
import { replaceFileWithRetry } from '../publication/publication-files.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';
import { publicationStepFailure } from '../publication/publication-failures.ts';

/**
 * The generation the published root manifest names, with its exact text; `absent` before the
 * first publication; `unreadable` when the manifest is damaged, names no generation, is not
 * this project's and mode's, or its assets are not the tool's (as the dry run's comparison tests
 * them).
 */
export type ActiveGeneration =
  | { readonly state: 'present'; readonly generation: string; readonly text: string }
  | { readonly state: 'absent' | 'unreadable' };

/** Whether a parsed manifest's header is the one the tool writes for this project and mode. */
function hasOwnHeader(value: Readonly<Record<string, unknown>>, owner: OutputOwner): boolean {
  return (
    value.schemaVersion === RUNTIME_MANIFEST_SCHEMA_VERSION &&
    value.projectId === owner.projectId &&
    value.outputMode === owner.outputMode
  );
}

/** Reads which generation the root manifest, the publication point, names. Reads only. */
export async function readActiveGeneration(
  layout: GenerationLayout,
  owner: OutputOwner,
): Promise<ActiveGeneration> {
  const reading = await readToolJson(layout.manifest, MAX_TOOL_JSON_BYTES);
  if (reading.state !== 'parsed') return { state: reading.state };
  const { value } = reading;
  if (!isJsonObject(value) || !hasOwnHeader(value, owner)) return { state: 'unreadable' };
  const isManifest = isSha256Hex(value.generation) && publishedAssetsOf(value) !== undefined;
  if (!isManifest) return { state: 'unreadable' };
  return { state: 'present', generation: value.generation as string, text: reading.text };
}

/**
 * Switches the root manifest to `manifestText` in one step, the commit point of a generation-mode
 * build: the text is written and flushed under a temporary name, then renamed over the manifest,
 * so a reader sees the old complete manifest or the new one. When the rename keeps failing (a
 * program holds the manifest open), the temporary file is removed and the old manifest stays,
 * still naming its complete generation (OUTPUT_IN_USE, exit 9).
 */
export async function switchManifest(
  fileSystem: PublicationFileSystem,
  layout: GenerationLayout,
  manifestText: string,
): Promise<void> {
  await writeFile(layout.manifestInProgress, manifestText, { flag: 'wx', flush: true });
  try {
    await replaceFileWithRetry(fileSystem, layout.manifestInProgress, layout.manifest);
  } catch (error) {
    if ((await entryKindAt(layout.manifestInProgress)) === 'file') {
      await fileSystem.unlink(layout.manifestInProgress).catch(() => undefined);
    }
    throw publicationStepFailure(layout.manifest, error, 'the previous manifest stays published');
  }
}
