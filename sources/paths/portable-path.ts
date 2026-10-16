import { isAbsolute, win32 } from 'node:path';

type PathRule = (path: string) => boolean;

const RESERVED_PATH_CHARACTERS = /[<>:"|?*\\]|\p{Cc}/u;
/** Globs may use `*`, `?`, `[]` and `{}`; everything else reserved on Windows stays forbidden. */
const RESERVED_GLOB_CHARACTERS = /[<>:"|\\]|\p{Cc}/u;
/** Device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(\..*)?$/i;
/** Windows silently drops trailing dots and spaces, so `a.` and `a` would be the same file. */
const WINDOWS_TRIMMED_ENDING = /[. ]$/;
/** `LONGNA~1`: Windows 8.3 short names alias another, longer name on the same volume. */
const WINDOWS_SHORT_NAME_TAIL = /~\d/;
/** Directories owned by version control or package managers; the tool must never claim them. */
const PROTECTED_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules']);

function isSafePathSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  const windowsTraps = [WINDOWS_DEVICE_NAME, WINDOWS_TRIMMED_ENDING, WINDOWS_SHORT_NAME_TAIL];
  return !windowsTraps.some((trap) => trap.test(segment));
}

const UNSAFE_RELATIVE_PATH_SHAPES: readonly PathRule[] = [
  (path) => path.length === 0,
  (path) => isAbsolute(path) || win32.isAbsolute(path),
  (path) => !path.split('/').every(isSafePathSegment),
];

function isUnsafeShape(path: string): boolean {
  return UNSAFE_RELATIVE_PATH_SHAPES.some((isUnsafe) => isUnsafe(path));
}

/**
 * A forward-slash relative path that means the same file on Windows, macOS and Linux: no
 * traversal, drive, UNC or absolute form, no characters or device names Windows reserves, no
 * alternate data streams and no segment Windows would silently trim.
 */
export function isPortableRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' && !isUnsafeShape(value) && !RESERVED_PATH_CHARACTERS.test(value)
  );
}

const INNERMOST_BRACE_GROUP = /\{([^{}]*)\}/;
const MAX_BRACE_ALTERNATIVES = 64;

/** Counts the plain patterns an expansion produces and refuses more than the maximum. */
class ExpansionBudget {
  private remaining = MAX_BRACE_ALTERNATIVES;

  spendOne(): boolean {
    this.remaining -= 1;
    return this.remaining >= 0;
  }
}

/** Expands one brace group; stops at the first failed alternative so cost stays bounded. */
function expandBraceGroup(
  glob: string,
  group: RegExpExecArray,
  budget: ExpansionBudget,
): string[] | undefined {
  const [wholeGroup, alternatives = ''] = group;
  const withAlternative = (alternative: string): string =>
    `${glob.slice(0, group.index)}${alternative}${glob.slice(group.index + wholeGroup.length)}`;
  const expansions: string[] = [];
  for (const alternative of alternatives.split(',')) {
    const expanded = expandWithinBudget(withAlternative(alternative), budget);
    if (!expanded) return undefined;
    expansions.push(...expanded);
  }
  return expansions;
}

function expandWithinBudget(glob: string, budget: ExpansionBudget): string[] | undefined {
  const group = INNERMOST_BRACE_GROUP.exec(glob);
  if (group) return expandBraceGroup(glob, group, budget);
  const isPlainPattern = !/[{}]/.test(glob);
  return isPlainPattern && budget.spendOne() ? [glob] : undefined;
}

/**
 * The plain patterns a brace glob stands for (`a/{b,c}` → `a/b`, `a/c`), innermost group first,
 * so nesting works too; `undefined` for unbalanced braces or more than 64 alternatives, which
 * also stops a pathological pattern before it can expand exponentially.
 */
export function expandBraces(glob: string): readonly string[] | undefined {
  // Bounding the group count also bounds recursion depth, which nesting would otherwise grow.
  const braceGroupCount = glob.split('{').length - 1;
  if (braceGroupCount > MAX_BRACE_ALTERNATIVES) return undefined;
  return expandWithinBudget(glob, new ExpansionBudget());
}

/** The characters of a glob segment outside `[...]` character classes. */
function charactersOutsideClasses(segment: string): string {
  let outside = '';
  let isInsideClass = false;
  for (const character of segment) {
    if (character === '[') isInsideClass = true;
    else if (character === ']') isInsideClass = false;
    else if (!isInsideClass) outside += character;
  }
  return outside;
}

/** `[.][.]` or `.[.]` can match `..`; a segment of only dots and classes could leave the base. */
function couldMatchDotSegment(segment: string): boolean {
  return segment.includes('[') && charactersOutsideClasses(segment).replaceAll('.', '') === '';
}

function isPortablePlainGlob(pattern: string): boolean {
  if (isUnsafeShape(pattern) || RESERVED_GLOB_CHARACTERS.test(pattern)) return false;
  return !pattern.split('/').some(couldMatchDotSegment);
}

/**
 * A glob relative to its base directory that can never leave it: every brace alternative must
 * itself be a portable relative pattern. `*`, `**`, `?` and `[...]` are allowed; negation is not.
 */
export function isPortableRelativeGlob(value: unknown): value is string {
  if (typeof value !== 'string' || value.startsWith('!')) return false;
  return expandBraces(value)?.every(isPortablePlainGlob) ?? false;
}

/** The comparison key under which case-insensitive file systems treat two paths as one. */
export function caseFoldedPath(path: string): string {
  // Lower, upper, lower: also folds pairs one pass misses, such as `ſ`/`s` and `ẞ`/`ß`/`ss`.
  return path.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

/** True when a segment is a version-control or dependency directory such as `.git`. */
export function hasProtectedDirectorySegment(path: string): boolean {
  return path.split('/').some((segment) => PROTECTED_DIRECTORY_NAMES.has(caseFoldedPath(segment)));
}
