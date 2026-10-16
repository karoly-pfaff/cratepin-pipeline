import { caseFoldedPath } from '../../paths/portable-path.ts';
import { configIssue } from './field-rules.ts';
import type { FieldRule, RawConfigObject } from './field-rules.ts';
import type { ConfigIssue } from '../pipeline-config.ts';

/** Segments of unreserved URL characters only, so the prefix needs no encoding. */
const URL_PATH_PATTERN = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;

function isOutputUrlPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  return (
    URL_PATH_PATTERN.test(value) && !value.split('/').some((segment) => /^\.+$/u.test(segment))
  );
}

export const OUTPUT_URL_PATH_RULE: FieldRule = {
  key: 'outputUrlPath',
  isValid: isOutputUrlPath,
  expectation:
    'Expected "" or a relative URL path of letters, digits and "._~-" segments, without a leading or trailing "/" or "." and ".." segments',
};

/**
 * The URL path at which `outputDir` is served, relative to the host's public root: the segments
 * after the last one named `public` (in any letter case); `undefined` when there is none.
 */
export function derivedOutputUrlPath(outputDir: string): string | undefined {
  const segments = outputDir.split('/');
  const publicIndex = segments.findLastIndex((segment) => caseFoldedPath(segment) === 'public');
  return publicIndex === -1 ? undefined : segments.slice(publicIndex + 1).join('/');
}

/**
 * An `outputUrlPath` left out must be derivable from `outputDir` and must then follow the same
 * rule as a given one: without a `public` segment, or with characters a URL path would need to
 * encode, it is never guessed and must be given.
 */
export function outputUrlPathIssues(raw: RawConfigObject, outputDir: string): ConfigIssue[] {
  if (raw.outputUrlPath !== undefined) return [];
  const derived = derivedOutputUrlPath(outputDir);
  if (derived === undefined) {
    return [
      configIssue(
        '/outputUrlPath',
        'outputDir has no "public" segment, so the URL path at which it is served cannot be derived; set outputUrlPath, for example "assets"',
      ),
    ];
  }
  if (isOutputUrlPath(derived)) return [];
  return [
    configIssue(
      '/outputUrlPath',
      `The URL path derived from outputDir ("${derived}") has characters a URL would need to encode; set outputUrlPath to letters, digits and "._~-" segments`,
    ),
  ];
}
