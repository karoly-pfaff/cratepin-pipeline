import { compareCodeUnits } from '../../catalog/ordering.ts';
import { PipelineError } from '../../errors.ts';
import { GENERATION_LISTING_NAME } from '../generation/generation-listing.ts';
import type { ListedFile } from '../generation/generation-listing.ts';
import { readGenerationListing } from '../generation/listing-reading.ts';
import { classifyOutputRoot, OUTPUT_MARKER_NAME } from './output-marker.ts';
import type { OutputOwner, OutputRootState } from './output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';
import { outputRootError } from './root-refusals.ts';
import { unlistedPathsOf, walkTree } from '../files/tree-audit.ts';

/** Unlisted entries named in a refusal; the rest are only counted. */
const NAMED_UNLISTED_ENTRY_LIMIT = 20;

/**
 * Every entry of a tree the tool did not write, by its listed files: anything but its marker,
 * listing and manifest, the listed files and the directories leading to them. Links, empty
 * directories and operating-system litter such as Thumbs.db count too.
 */
async function entriesNotListedIn(
  root: string,
  listedFiles: readonly ListedFile[],
): Promise<string[]> {
  const expected = new Set([
    OUTPUT_MARKER_NAME,
    GENERATION_LISTING_NAME,
    RUNTIME_MANIFEST_NAME,
    ...listedFiles.map(({ path }) => path),
  ]);
  return unlistedPathsOf(await walkTree(root), expected).toSorted(compareCodeUnits);
}

function unlistedEntriesError(root: string, entries: readonly string[]): PipelineError {
  const named = entries.slice(0, NAMED_UNLISTED_ENTRY_LIMIT).join(', ');
  return new PipelineError(
    'OUTPUT_CONFLICT',
    `The output directory holds ${String(entries.length)} entries the tool did not write (${named}); a build replaces the whole directory, so move them elsewhere first.`,
    { reason: 'UNLISTED_OUTPUT_ENTRY', path: root, entryCount: entries.length },
  );
}

function listingInvalidError(root: string): PipelineError {
  return new PipelineError(
    'OUTPUT_CONFLICT',
    `The output directory's ${GENERATION_LISTING_NAME} is missing or damaged, so the tool cannot tell its own files from others; move the directory aside, build again, then compare and delete the old copy deliberately.`,
    { reason: 'OUTPUT_LISTING_INVALID', path: root },
  );
}

/**
 * Why an owned root may not be replaced, or `undefined` when it may: its listing is missing or
 * damaged (OUTPUT_LISTING_INVALID), or it holds entries the tool did not write
 * (UNLISTED_OUTPUT_ENTRY). Both are OUTPUT_CONFLICT, exit 9. A marker alone is not trusted, as a
 * swap moves the whole root aside.
 */
export async function ownedRootError(root: string): Promise<PipelineError | undefined> {
  const listing = await readGenerationListing(root);
  if (listing === undefined) return listingInvalidError(root);
  const unlisted = await entriesNotListedIn(root, listing.files);
  return unlisted.length === 0 ? undefined : unlistedEntriesError(root, unlisted);
}

/**
 * The cheap first look at the output root, reading no more than its marker: absent, empty or
 * owned by this project and mode, or the refusal is thrown (exit 9, or 10 when its parent is
 * missing).
 */
export async function assertRootNotRefused(
  root: string,
  owner: OutputOwner,
): Promise<OutputRootState> {
  const state = await classifyOutputRoot(root, owner);
  const refusal = outputRootError(state, root);
  if (refusal !== undefined) throw refusal;
  return state;
}

/**
 * Makes sure a build may replace the output root: it is absent or empty, or marked for this
 * project and mode with a readable listing and nothing the tool did not write. Anything else
 * throws the refusal (exit 9, or 10 when its parent is missing); nothing is changed.
 */
export async function assertReplaceableRoot(
  root: string,
  owner: OutputOwner,
): Promise<OutputRootState> {
  const state = await assertRootNotRefused(root, owner);
  if (state.state !== 'owned') return state;
  const refusal = await ownedRootError(root);
  if (refusal !== undefined) throw refusal;
  return state;
}
