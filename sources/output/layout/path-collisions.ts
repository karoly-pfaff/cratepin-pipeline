import { compareCodeUnits } from '../../catalog/ordering.ts';
import { caseFoldedPath } from '../../paths/portable-path.ts';
import { GENERATION_LISTING_NAME } from '../generation/generation-listing.ts';
import { directoriesLeadingTo } from '../files/output-files.ts';
import { isMarkerInProgress, OUTPUT_MARKER_NAME } from '../ownership/output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from './output-paths.ts';

/** One asset's logical ID with every output path it may get. */
export interface PlannedPaths {
  readonly id: string;
  readonly paths: readonly string[];
}

/** Two assets whose outputs would land on one file or directory, or a reserved name. */
export interface PathConflict {
  readonly code: 'OUTPUT_PATH_COLLISION' | 'OUTPUT_PATH_RESERVED';
  readonly path: string;
  readonly ids: readonly string[];
  readonly message: string;
}

/** A path as one asset may write it, with its case-folded form. */
interface ClaimedPath {
  readonly id: string;
  readonly path: string;
  readonly folded: string;
}

function claimedPathsOf(planned: readonly PlannedPaths[]): ClaimedPath[] {
  return planned.flatMap(({ id, paths }) =>
    paths.map((path) => ({ id, path, folded: caseFoldedPath(path) })),
  );
}

/** Names the tool writes at the top of an output root, case-folded. */
const TOOL_FILE_NAMES = new Set(
  [RUNTIME_MANIFEST_NAME, OUTPUT_MARKER_NAME, GENERATION_LISTING_NAME].map(caseFoldedPath),
);

function isToolFileName(topName: string): boolean {
  return TOOL_FILE_NAMES.has(topName) || isMarkerInProgress(topName);
}

function reservedConflicts(claimed: readonly ClaimedPath[]): PathConflict[] {
  return claimed
    .filter(({ folded }) => isToolFileName(folded.split('/')[0] ?? ''))
    .map(({ id, path }) => ({
      code: 'OUTPUT_PATH_RESERVED',
      path,
      ids: [id],
      message: `${path.split('/')[0] ?? path} at the top of the output is a file the tool writes there (the runtime manifest, the output marker or the file listing), as a file and as a directory name; move or rename this source.`,
    }));
}

/** Files of two assets that one case-insensitive file system would store under one name. */
function fileConflicts(claimed: readonly ClaimedPath[]): PathConflict[] {
  const firstByFolded = new Map<string, ClaimedPath>();
  const conflicts: PathConflict[] = [];
  for (const entry of claimed) {
    const first = firstByFolded.get(entry.folded);
    if (first === undefined) firstByFolded.set(entry.folded, entry);
    else if (first.id !== entry.id) conflicts.push(collision(first, entry, 'the same output file'));
  }
  return conflicts;
}

/** Every directory the claimed files need, as the asset that needs it spells it. */
function claimedDirectoriesOf(claimed: readonly ClaimedPath[]): ClaimedPath[] {
  return claimed.flatMap((entry) =>
    directoriesLeadingTo(entry.path).map((path) => ({
      id: entry.id,
      path,
      folded: caseFoldedPath(path),
    })),
  );
}

/** The first spelling of each directory, and one conflict per other spelling of it. */
function directorySpellings(claimed: readonly ClaimedPath[]): {
  readonly firstSpelling: ReadonlyMap<string, ClaimedPath>;
  readonly conflicts: readonly PathConflict[];
} {
  const firstSpelling = new Map<string, ClaimedPath>();
  const conflictBySpelling = new Map<string, PathConflict>();
  for (const directory of claimedDirectoriesOf(claimed)) {
    const first = firstSpelling.get(directory.folded) ?? directory;
    firstSpelling.set(directory.folded, first);
    if (first.path !== directory.path && !conflictBySpelling.has(directory.path)) {
      conflictBySpelling.set(directory.path, collision(first, directory, 'one directory'));
    }
  }
  return { firstSpelling, conflicts: [...conflictBySpelling.values()] };
}

/** A directory spelled two ways, or one asset's file where another asset needs a directory. */
function directoryConflicts(claimed: readonly ClaimedPath[]): PathConflict[] {
  const { firstSpelling, conflicts } = directorySpellings(claimed);
  const filesOnDirectories = claimed.flatMap((file) => {
    const directory = firstSpelling.get(file.folded);
    return directory === undefined ? [] : [fileOnDirectory(directory, file)];
  });
  return [...conflicts, ...filesOnDirectories];
}

function fileOnDirectory(directory: ClaimedPath, file: ClaimedPath): PathConflict {
  return {
    code: 'OUTPUT_PATH_COLLISION',
    path: file.path,
    ids: [directory.id, file.id].toSorted(compareCodeUnits),
    message: `"${file.path}" is the output file of "${file.id}", but "${directory.id}" needs a directory there; rename one source or give one asset another profile.`,
  };
}

function collision(first: ClaimedPath, second: ClaimedPath, what: string): PathConflict {
  return {
    code: 'OUTPUT_PATH_COLLISION',
    path: second.path,
    ids: [first.id, second.id].toSorted(compareCodeUnits),
    message: `"${first.path}" and "${second.path}" would be ${what} on a case-insensitive file system; rename one source or give one asset another profile.`,
  };
}

/**
 * Every way the planned outputs would clash in one output tree, judged ignoring letter case as
 * Windows and macOS do: two assets on one file, a directory spelled two ways, a file where a
 * directory must be, or the reserved runtime manifest name. Found before anything is written.
 */
export function outputPathConflicts(planned: readonly PlannedPaths[]): PathConflict[] {
  const claimed = claimedPathsOf(planned);
  return [...reservedConflicts(claimed), ...fileConflicts(claimed), ...directoryConflicts(claimed)];
}
