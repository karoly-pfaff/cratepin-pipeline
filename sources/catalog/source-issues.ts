import { toPipelineError } from '../errors.ts';
import { compareCodeUnits } from './ordering.ts';

/** Stable codes for everything a source inventory or catalog can find wrong or worth knowing. */
export type SourceIssueCode =
  | 'NOT_A_REGULAR_FILE'
  | 'UNREADABLE_SOURCE'
  | 'UNPORTABLE_PATH'
  | 'UNSUPPORTED_MEDIA'
  | 'CATEGORY_MISMATCH'
  | 'SOURCE_TOO_LARGE'
  | 'CASE_COLLISION'
  | 'DUPLICATE_CONTENT'
  | 'UNMATCHED_PATTERN'
  | 'MISSING_SOURCE'
  | 'INVALID_ID'
  | 'DUPLICATE_ID'
  | 'SOURCES_MISSING'
  | 'IDENTITY_CHANGED';

/**
 * One finding. `path` is the source path relative to `sourceDir` (`.` for `sourceDir` itself),
 * or a config path such as `/sources/include/0` (always starting with `/`) when the finding is
 * about the configuration.
 */
export interface SourceIssue {
  readonly path: string;
  readonly code: SourceIssueCode;
  readonly message: string;
}

/** Notices describe a usable inventory; every other code makes it unusable for a lock. */
const NOTICE_CODES: ReadonlySet<SourceIssueCode> = new Set([
  'DUPLICATE_CONTENT',
  'UNMATCHED_PATTERN',
  'IDENTITY_CHANGED',
]);

const STANDARD_MESSAGES: Readonly<Record<SourceIssueCode, string>> = {
  NOT_A_REGULAR_FILE:
    'Links and special files are neither followed nor read, wherever they are in sourceDir.',
  UNREADABLE_SOURCE: 'The file or directory cannot be read.',
  UNPORTABLE_PATH: 'The path cannot be stored the same way on Windows, macOS and Linux.',
  UNSUPPORTED_MEDIA: 'The file extension is not a supported media format.',
  CATEGORY_MISMATCH:
    'The format does not suit the category (images need image formats, ' +
    'voice, effects and music need audio formats).',
  SOURCE_TOO_LARGE: 'The file is larger than limits.maxSourceBytes; it is not inventoried.',
  CASE_COLLISION: 'Paths that differ only in letter case or Unicode form would be one file.',
  DUPLICATE_CONTENT: 'Files with identical bytes share one stored original.',
  UNMATCHED_PATTERN: 'The include pattern selects no file.',
  MISSING_SOURCE:
    'The assets entry names a source that the inventory does not contain: it is missing, ' +
    'renamed or not selected by sources.include.',
  INVALID_ID:
    'The ID derived from the path is not portable; give the file an explicit id in assets.',
  DUPLICATE_ID:
    'Several sources would get the same logical ID (letter case and Unicode form ignored); ' +
    'give them distinct ids in assets.',
  SOURCES_MISSING:
    'The source directory holds none of the originals the committed lock lists; restore them ' +
    'first, otherwise a push would empty the lock.',
  IDENTITY_CHANGED:
    'Bytes that the committed lock knows under another ID appear under a new ID, usually after ' +
    'a rename; to keep the old ID, give this source that id in assets.',
};

export function sourceIssue(path: string, code: SourceIssueCode, detail?: string): SourceIssue {
  const message = STANDARD_MESSAGES[code];
  return { path, code, message: detail === undefined ? message : `${message} ${detail}` };
}

/** An UNREADABLE_SOURCE issue naming only the system error code, never the raw message. */
export function unreadableIssue(path: string, error: unknown): SourceIssue {
  const { systemCode } = toPipelineError(error).details;
  const detail = systemCode === undefined ? undefined : `System code: ${String(systemCode)}.`;
  return sourceIssue(path, 'UNREADABLE_SOURCE', detail);
}

export function isBlockingIssue(issue: SourceIssue): boolean {
  return !NOTICE_CODES.has(issue.code);
}

/** The result of checking one item: it passed, or it became an issue. */
export type Checked<Item> = { readonly accepted: Item } | { readonly rejected: SourceIssue };

export function accept<Item>(item: Item): Checked<Item> {
  return { accepted: item };
}

export function reject(issue: SourceIssue): Checked<never> {
  return { rejected: issue };
}

/** The items that passed a check and the issues for those that did not. */
export interface CheckOutcome<Item> {
  readonly accepted: readonly Item[];
  readonly issues: readonly SourceIssue[];
}

export function outcomeOf<Item>(results: readonly Checked<Item>[]): CheckOutcome<Item> {
  return {
    accepted: results.flatMap((result) => ('accepted' in result ? [result.accepted] : [])),
    issues: results.flatMap((result) => ('rejected' in result ? [result.rejected] : [])),
  };
}

/** One issue per member of each group, naming all members in order, e.g. `A.png, a.png`. */
export function issuesForGroupMembers(
  groups: readonly (readonly string[])[],
  code: SourceIssueCode,
): SourceIssue[] {
  return groups.flatMap((group) => {
    const members = group.toSorted(compareCodeUnits);
    return members.map((path) => sourceIssue(path, code, `Group: ${members.join(', ')}.`));
  });
}

/** The groups of two or more items that share a key. */
export function groupsSharingKey<Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string,
): Item[][] {
  return [...Map.groupBy(items, keyOf).values()].filter((group) => group.length > 1);
}
