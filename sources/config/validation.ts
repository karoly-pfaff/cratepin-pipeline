import { caseFoldedPath, isPortableRelativePath } from '../paths/portable-path.ts';
import { OUTPUT_MODES, SUPPORTED_SCHEMA_VERSIONS } from './pipeline-config.ts';
import type { ConfigIssue, ConfigValidation } from './pipeline-config.ts';
import { profileSectionIssues, sourcesSectionIssues } from './rules/media-rules.ts';
import { normalizeConfig } from './normalization.ts';
import {
  configIssue,
  fieldIssues,
  isCheckedByNestedRules,
  isOneOf,
  isPlainObject,
  isSlug,
  nestedObjectIssues,
} from './rules/field-rules.ts';
import type { FieldRule, RawConfigObject } from './rules/field-rules.ts';
import { assetSectionIssues } from './rules/asset-rules.ts';
import { credentialShapedIssues } from './rules/credential-scan.ts';
import { limitSectionIssues } from './rules/limit-rules.ts';
import { OUTPUT_URL_PATH_RULE, outputUrlPathIssues } from './rules/output-url-rules.ts';
import { relationIssues } from './rules/relation-rules.ts';
import { r2SectionIssues } from './rules/storage-rules.ts';

const PATH_EXPECTATION =
  'Expected a portable forward-slash relative path: no "..", drive or absolute form, no reserved characters, Windows device names (CON, NUL, COM1), 8.3 short names (NAME~1) or segments ending in a dot or space';

function isOwnedOutputDir(value: unknown): boolean {
  const lastSegment = isPortableRelativePath(value) ? (value.split('/').at(-1) ?? '') : 'public';
  return caseFoldedPath(lastSegment) !== 'public';
}

function pathRule(key: string): FieldRule {
  return { key, isValid: isPortableRelativePath, expectation: PATH_EXPECTATION };
}

function nestedRule(key: string): FieldRule {
  return { key, isValid: isCheckedByNestedRules, expectation: '' };
}

const TOP_LEVEL_FIELDS: readonly FieldRule[] = [
  {
    key: 'schemaVersion',
    isValid: isOneOf(SUPPORTED_SCHEMA_VERSIONS),
    expectation: `Unsupported schemaVersion; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    isRequired: true,
  },
  {
    key: 'projectId',
    isValid: isSlug,
    expectation: 'Use a lowercase portable slug',
    isRequired: true,
  },
  pathRule('sourceDir'),
  pathRule('cacheDir'),
  pathRule('lockFile'),
  pathRule('objectPrefix'),
  {
    key: 'outputDir',
    isValid: isOwnedOutputDir,
    expectation:
      'Expected a dedicated output subdirectory, not one named "public" in any letter case, given as a forward-slash relative path without ".." segments',
  },
  {
    key: 'outputMode',
    isValid: isOneOf(OUTPUT_MODES),
    expectation: 'Expected "path-preserving" or "generation"',
  },
  OUTPUT_URL_PATH_RULE,
  { key: 'defaultProfile', isValid: isSlug, expectation: 'Expected a profile name' },
  ...['sources', 'r2', 'profiles', 'profileRules', 'assets', 'limits'].map(nestedRule),
];

function shapeIssues(raw: RawConfigObject): ConfigIssue[] {
  return [
    ...credentialShapedIssues(raw),
    ...fieldIssues(raw, '', TOP_LEVEL_FIELDS),
    ...nestedObjectIssues(raw.sources, '/sources', sourcesSectionIssues),
    ...nestedObjectIssues(raw.r2, '/r2', r2SectionIssues),
    ...profileSectionIssues(raw.profiles, raw.profileRules),
    ...assetSectionIssues(raw.assets),
    ...nestedObjectIssues(raw.limits, '/limits', limitSectionIssues),
  ];
}

/** Validates raw config JSON and returns it normalized with defaults, or every issue found. */
export function validateConfig(value: unknown): ConfigValidation {
  if (!isPlainObject(value)) return { ok: false, issues: [configIssue('/', 'Expected an object')] };
  const issues = shapeIssues(value);
  if (issues.length > 0) return { ok: false, issues };
  const config = structuredClone(normalizeConfig(value));
  const crossFieldIssues = [
    ...outputUrlPathIssues(value, config.outputDir),
    ...relationIssues(config),
  ];
  if (crossFieldIssues.length > 0) return { ok: false, issues: crossFieldIssues };
  return { ok: true, config };
}
