import type { MediaCategory, PipelineConfig } from '../config/pipeline-config.ts';
import { caseFoldedPath, isPortableRelativePath } from '../paths/portable-path.ts';
import { compileGlob } from '../paths/matching/glob-matcher.ts';
import { mediaTypeOf, suitsCategory } from './media-types.ts';
import { accept, outcomeOf, reject, sourceIssue } from './source-issues.ts';
import type { Checked, CheckOutcome } from './source-issues.ts';

/** A selected file whose path, format and category are acceptable; not yet read. */
export interface SourceCandidate {
  readonly path: string;
  readonly mediaType: string;
  readonly category: MediaCategory;
}

/** Files matched by at least one include pattern, plus a notice for each pattern that matched none. */
export function selectIncludedFiles(
  files: readonly string[],
  include: readonly string[],
): CheckOutcome<string> {
  const matchers = include.map(compileGlob);
  const accepted = files.filter((file) => matchers.some((matches) => matches(file)));
  const issues = matchers.flatMap((matches, index) =>
    accepted.some(matches)
      ? []
      : [sourceIssue(`/sources/include/${String(index)}`, 'UNMATCHED_PATTERN')],
  );
  return { accepted, issues };
}

type CategorySettings = Pick<PipelineConfig, 'sources' | 'assets'>;

/** The category an `assets` entry sets, else the first matching rule's, else `other`. */
function categorizer({ sources, assets }: CategorySettings): (path: string) => MediaCategory {
  const compiledRules = sources.categories.map((rule) => ({
    matches: compileGlob(rule.match),
    category: rule.category,
  }));
  const authoredCategories = new Map(
    assets.flatMap(({ source, category }) =>
      category === undefined ? [] : [[caseFoldedPath(source), category] as const],
    ),
  );
  return (path) =>
    authoredCategories.get(caseFoldedPath(path)) ??
    compiledRules.find(({ matches }) => matches(path))?.category ??
    'other';
}

function classifySource(
  path: string,
  categoryOf: (path: string) => MediaCategory,
): Checked<SourceCandidate> {
  if (!isPortableRelativePath(path)) return reject(sourceIssue(path, 'UNPORTABLE_PATH'));
  const mediaType = mediaTypeOf(path);
  if (mediaType === undefined) return reject(sourceIssue(path, 'UNSUPPORTED_MEDIA'));
  const category = categoryOf(path);
  if (!suitsCategory(category, mediaType)) return reject(sourceIssue(path, 'CATEGORY_MISMATCH'));
  return accept({ path, mediaType, category });
}

/** Assigns format and category to each selected file; files that cannot be stored become issues. */
export function classifySources(
  paths: readonly string[],
  settings: CategorySettings,
): CheckOutcome<SourceCandidate> {
  const categoryOf = categorizer(settings);
  return outcomeOf(paths.map((path) => classifySource(path, categoryOf)));
}
