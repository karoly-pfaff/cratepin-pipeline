import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { PipelineError } from '../../errors.ts';
import { ensureDirectory } from '../../paths/files/create-only-files.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import type { ReportIssue } from '../../report.ts';
import {
  isGenerationName,
  isGenerationRootName,
  isGenerationWorkName,
} from './generation-layout.ts';
import type { GenerationLayout } from './generation-layout.ts';
import { linkOutputMarker, removeMarkersInProgress } from '../ownership/marker-writing.ts';
import { isMarkerInProgress, OUTPUT_MARKER_NAME } from '../ownership/output-marker.ts';
import type { OutputOwner } from '../ownership/output-marker.ts';
import { readGenerationListing } from './listing-reading.ts';
import { readActiveGeneration } from '../manifest/manifest-switch.ts';
import { assertRootNotRefused } from '../ownership/owned-root.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';

/** Whether `generations/` is absent or a real directory (not a link, junction or file). */
export async function isGenerationsUsable(layout: GenerationLayout): Promise<boolean> {
  const kind = await entryKindAt(layout.generations);
  return kind === 'absent' || kind === 'directory';
}

/** A link or file where `generations/` belongs: nothing is built, published or read through it. */
export function generationsNotADirectoryError(layout: GenerationLayout): PipelineError {
  return new PipelineError(
    'OUTPUT_CONFLICT',
    'A file or link is where the output directory keeps its generations; nothing is built or read through it.',
    { reason: 'OUTPUT_NOT_A_DIRECTORY', path: layout.generations },
  );
}

/** The published manifest is damaged, names no generation or is not the tool's for this project and mode: never replaced. */
export function manifestInvalidError(layout: GenerationLayout): PipelineError {
  return new PipelineError(
    'OUTPUT_CONFLICT',
    "The output directory holds an cratepin-manifest.json that is damaged, or not this tool's for this project and output mode, so it is not replaced; move it aside and build again.",
    { reason: 'OUTPUT_MANIFEST_INVALID', path: layout.manifest },
  );
}

/**
 * Why an owned or new generation-mode root still may not be published into, or `undefined`: a
 * link or file where `generations/` belongs (OUTPUT_NOT_A_DIRECTORY), or a root manifest that
 * is damaged or not the tool's for this project and mode (OUTPUT_MANIFEST_INVALID). Both exit 9; reads only.
 */
export async function generationRootError(
  layout: GenerationLayout,
  owner: OutputOwner,
): Promise<PipelineError | undefined> {
  if (!(await isGenerationsUsable(layout))) return generationsNotADirectoryError(layout);
  const active = await readActiveGeneration(layout, owner);
  return active.state === 'unreadable' ? manifestInvalidError(layout) : undefined;
}

/**
 * Makes sure a generation-mode build may publish into the root: absent, empty or owned by this
 * project and mode (else the refusal from its marker), with neither refusal of
 * `generationRootError`. The root is never moved, so other entries are not refused; they are
 * kept and reported.
 */
export async function assertGenerationRoot(
  layout: GenerationLayout,
  owner: OutputOwner,
): Promise<void> {
  await assertRootNotRefused(layout.root, owner);
  const refusal = await generationRootError(layout, owner);
  if (refusal !== undefined) throw refusal;
}

/**
 * Makes the root this project's generation-mode output: creates it (never its parent) or marks
 * an empty one with the marker, linked into place once written, removes markers a crashed run
 * left half-written, then makes sure `generations/` is a real directory. An owned root stays as it is; any other root is refused, unchanged.
 */
export async function ownGenerationRoot(
  fileSystem: PublicationFileSystem,
  layout: GenerationLayout,
  owner: OutputOwner,
): Promise<void> {
  const { state } = await assertRootNotRefused(layout.root, owner);
  if (state === 'absent') await fileSystem.mkdir(layout.root);
  const isLinked = state !== 'owned' && (await linkOutputMarker(layout.root, owner));
  // Another run linked its marker first: it must be this project's, as for an owned root.
  if (state !== 'owned' && !isLinked) await assertRootNotRefused(layout.root, owner);
  await removeMarkersInProgress(layout.root);
  await ensureDirectory(layout.generations);
}

function unknownNameNotice(path: string): ReportIssue {
  return {
    path,
    code: 'UNKNOWN_OUTPUT_NAME',
    message:
      'Not written by the tool, so it is kept and never served by the manifest; remove it if nothing needs it.',
  };
}

async function namesIn(directory: string): Promise<string[]> {
  if ((await entryKindAt(directory)) !== 'directory') return [];
  return (await readdir(directory)).toSorted(compareCodeUnits);
}

/**
 * Whether `generations/<name>` is a generation the tool made: a generation's name, a real
 * directory and a readable listing. Only such a directory is ever retired.
 */
export async function isGenerationAt(layout: GenerationLayout, name: string): Promise<boolean> {
  const path = join(layout.generations, name);
  if (!isGenerationName(name) || (await entryKindAt(path)) !== 'directory') return false;
  return (await readGenerationListing(path).catch(() => undefined)) !== undefined;
}

/** An entry of `generations/` the tool did not make: anything but a generation, staging or trash. */
async function isForeignGenerationEntry(layout: GenerationLayout, name: string): Promise<boolean> {
  if (isGenerationWorkName(name)) {
    return (await entryKindAt(join(layout.generations, name))) !== 'directory';
  }
  return !(await isGenerationAt(layout, name));
}

/**
 * Every entry of a generation-mode root the tool did not write, as notices: at the top anything
 * but the marker, the manifest (and its temporary name) and `generations/`; in `generations/`
 * anything but generation directories, staging and trash. They are never touched.
 */
export async function unknownNameNotices(layout: GenerationLayout): Promise<ReportIssue[]> {
  const topNames = (await namesIn(layout.root)).filter(
    (name) =>
      name !== OUTPUT_MARKER_NAME && !isMarkerInProgress(name) && !isGenerationRootName(name),
  );
  const generationNames = await namesIn(layout.generations);
  const foreignGenerationNames: string[] = [];
  for (const name of generationNames) {
    if (await isForeignGenerationEntry(layout, name)) foreignGenerationNames.push(name);
  }
  return [
    ...topNames.map((name) => unknownNameNotice(join(layout.root, name))),
    ...foreignGenerationNames.map((name) => unknownNameNotice(join(layout.generations, name))),
  ];
}
