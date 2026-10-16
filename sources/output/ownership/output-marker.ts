import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { compareCodeUnits } from '../../catalog/ordering.ts';
import { PipelineError } from '../../errors.ts';
import type { OutputMode } from '../../config/pipeline-config.ts';
import { isJsonObject } from '../../json/strict-json.ts';
import { readToolJson } from '../files/output-files.ts';
import { entryKindAt } from '../../paths/path-containment.ts';

/** The hidden file that marks a directory as this tool's output for one project and mode. */
export const OUTPUT_MARKER_NAME = '.cratepin-output.json';

/** A marker being written: linked into place once complete, then removed. */
const MARKER_IN_PROGRESS = /^\.cratepin-output\.json\.[0-9a-f-]{36}\.tmp$/u;

export function isMarkerInProgress(name: string): boolean {
  return MARKER_IN_PROGRESS.test(name);
}

const OUTPUT_MARKER_SCHEMA_VERSION = 1;
const TOOL_NAME = 'cratepin';
/** A marker is a line of JSON; anything far larger at its name is not one. */
const MAX_MARKER_BYTES = 4096;
/** Names of an unowned root listed in a refusal; the rest are only counted. */
const LISTED_FOREIGN_NAMES = 20;

/** Whose output a root is, as far as its marker says. */
export interface OutputOwner {
  readonly projectId: string;
  readonly outputMode: OutputMode;
}

/** What the output root is before a build touches it. */
export type OutputRootState =
  | { readonly state: 'absent' | 'empty' | 'owned' | 'parent-missing' | 'marker-invalid' }
  | { readonly state: 'not-owned'; readonly names: readonly string[]; readonly nameCount: number }
  | { readonly state: 'foreign-project'; readonly markedProjectId: string }
  | { readonly state: 'mode-changed'; readonly markedMode: string }
  | { readonly state: 'not-a-directory'; readonly path: string };

/** The marker's exact text: no time, uuid or machine, so it is the same on every build. */
export function outputMarkerTextOf({ projectId, outputMode }: OutputOwner): string {
  const marker = {
    schemaVersion: OUTPUT_MARKER_SCHEMA_VERSION,
    tool: TOOL_NAME,
    projectId,
    outputMode,
  };
  return `${JSON.stringify(marker)}\n`;
}

function isOutputMode(value: unknown): value is OutputMode {
  return value === 'path-preserving' || value === 'generation';
}

/** The owner a parsed marker names, or `undefined` when it is not a marker of this tool. */
function ownerOf(value: unknown): OutputOwner | undefined {
  if (!isJsonObject(value)) return undefined;
  const { schemaVersion, tool, projectId, outputMode } = value;
  const isThisToolsMarker = schemaVersion === OUTPUT_MARKER_SCHEMA_VERSION && tool === TOOL_NAME;
  const isOwner = typeof projectId === 'string' && isOutputMode(outputMode);
  return isThisToolsMarker && isOwner ? { projectId, outputMode } : undefined;
}

/** The marker's owner, or `undefined` for anything that is not a marker of this tool. */
async function markedOwnerAt(root: string): Promise<OutputOwner | undefined> {
  const reading = await readToolJson(join(root, OUTPUT_MARKER_NAME), MAX_MARKER_BYTES);
  return reading.state === 'parsed' ? ownerOf(reading.value) : undefined;
}

function markedState(marked: OutputOwner | undefined, owner: OutputOwner): OutputRootState {
  if (marked === undefined) return { state: 'marker-invalid' };
  if (marked.projectId !== owner.projectId) {
    return { state: 'foreign-project', markedProjectId: marked.projectId };
  }
  if (marked.outputMode !== owner.outputMode) {
    return { state: 'mode-changed', markedMode: marked.outputMode };
  }
  return { state: 'owned' };
}

/**
 * A generation root holding nothing but markers a run is writing (or left half-written) is empty.
 * Only generation builds write markers that way, so in any other mode such a file is foreign.
 */
async function existingRootState(root: string, owner: OutputOwner): Promise<OutputRootState> {
  const isGeneration = owner.outputMode === 'generation';
  const names = (await readdir(root))
    .filter((name) => !(isGeneration && isMarkerInProgress(name)))
    .toSorted(compareCodeUnits);
  if (names.length === 0) return { state: 'empty' };
  if (names.includes(OUTPUT_MARKER_NAME)) return markedState(await markedOwnerAt(root), owner);
  return {
    state: 'not-owned',
    names: names.slice(0, LISTED_FOREIGN_NAMES),
    nameCount: names.length,
  };
}

function unreadable(path: string): PipelineError {
  return new PipelineError('IO_FAILED', 'The output directory cannot be inspected.', { path });
}

/**
 * The parent's refusal, if any: the root is only ever made or replaced inside a real, existing
 * parent directory, never below a link or junction.
 */
async function parentRefusal(parent: string): Promise<OutputRootState | undefined> {
  const kind = await entryKindAt(parent);
  if (kind === 'directory') return undefined;
  if (kind === 'absent') return { state: 'parent-missing' };
  if (kind === 'unreadable') throw unreadable(parent);
  return { state: 'not-a-directory', path: parent };
}

/**
 * Tells, reading only, what the output root is: missing (or even its parent, which the tool
 * never creates), empty, marked as this project's output in this mode, or something a build must
 * not touch: marked for another project or mode, a broken marker, content without a marker, or
 * a link, junction or file where a real directory must be. An entry that cannot be inspected is
 * IO_FAILED. A marker alone does not make files removable; publication checks every entry again.
 */
export async function classifyOutputRoot(
  root: string,
  owner: OutputOwner,
): Promise<OutputRootState> {
  const refusedParent = await parentRefusal(dirname(root));
  if (refusedParent !== undefined) return refusedParent;
  const kind = await entryKindAt(root);
  if (kind === 'directory') return existingRootState(root, owner);
  if (kind === 'absent') return { state: 'absent' };
  if (kind === 'unreadable') throw unreadable(root);
  return { state: 'not-a-directory', path: root };
}
