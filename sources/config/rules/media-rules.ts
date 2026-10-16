import { BUILT_IN_COPY_PROFILE, MEDIA_CATEGORIES, RESIZE_FITS } from '../pipeline-config.ts';
import type { ConfigIssue } from '../pipeline-config.ts';
import {
  arrayItemIssues,
  childPath,
  configIssue,
  fieldIssues,
  isBoolean,
  isCheckedByNestedRules,
  isIntegerBetween,
  isOneOf,
  isPlainObject,
  isSlug,
  nestedObjectIssues,
  objectItemIssues,
} from './field-rules.ts';
import type { FieldRule, RawConfigObject } from './field-rules.ts';
import { isUsableGlob } from '../../paths/matching/glob-matcher.ts';

const MAX_RESIZE_EDGE = 16_384;
const GLOB_EXPECTATION =
  'Expected a forward-slash relative glob without ".." segments and with valid [...] classes';

const globRule: FieldRule = {
  key: 'match',
  isValid: isUsableGlob,
  expectation: GLOB_EXPECTATION,
  isRequired: true,
};

const CATEGORY_RULE_FIELDS: readonly FieldRule[] = [
  globRule,
  {
    key: 'category',
    isValid: isOneOf(MEDIA_CATEGORIES),
    expectation: `Expected one of ${MEDIA_CATEGORIES.join(', ')}`,
    isRequired: true,
  },
];

const PROFILE_RULE_FIELDS: readonly FieldRule[] = [
  globRule,
  { key: 'profile', isValid: isSlug, expectation: 'Expected a profile name', isRequired: true },
];

const SOURCES_FIELDS: readonly FieldRule[] = [
  { key: 'include', isValid: isCheckedByNestedRules, expectation: '' },
  { key: 'categories', isValid: isCheckedByNestedRules, expectation: '' },
];

const RESIZE_FIELDS: readonly FieldRule[] = [
  edgeRule('width'),
  edgeRule('height'),
  {
    key: 'fit',
    isValid: isOneOf(RESIZE_FITS),
    expectation: 'Expected "contain" or "inside"',
  },
];

const WEBP_FIELDS: readonly FieldRule[] = [
  { key: 'lossless', isValid: isBoolean, expectation: 'Expected true or false' },
  { key: 'quality', isValid: isIntegerBetween(1, 100), expectation: 'Expected an integer 1–100' },
  {
    key: 'alphaQuality',
    isValid: isIntegerBetween(0, 100),
    expectation: 'Expected an integer 0–100',
  },
  { key: 'keepSmaller', isValid: isBoolean, expectation: 'Expected true or false' },
];

const COPY_PROFILE_FIELDS: readonly FieldRule[] = [
  { key: 'kind', isValid: isOneOf(['copy']), expectation: 'Expected "copy"', isRequired: true },
];

const IMAGE_PROFILE_FIELDS: readonly FieldRule[] = [
  { key: 'kind', isValid: isOneOf(['image']), expectation: 'Expected "image"', isRequired: true },
  { key: 'resize', isValid: isCheckedByNestedRules, expectation: '' },
  { key: 'webp', isValid: isCheckedByNestedRules, expectation: '' },
];

function edgeRule(key: string): FieldRule {
  const expectation = `Expected an integer 1–${String(MAX_RESIZE_EDGE)} (pixels)`;
  return { key, isValid: isIntegerBetween(1, MAX_RESIZE_EDGE), expectation, isRequired: true };
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function globItemIssues(item: unknown, itemPath: string): ConfigIssue[] {
  return isUsableGlob(item) ? [] : [configIssue(itemPath, GLOB_EXPECTATION)];
}

/** Shape issues of the optional `sources` section: include globs and category rules. */
export function sourcesSectionIssues(sources: RawConfigObject): ConfigIssue[] {
  const emptyInclude = sources.include !== undefined && !isNonEmptyArray(sources.include);
  return [
    ...fieldIssues(sources, '/sources', SOURCES_FIELDS),
    ...(emptyInclude
      ? [configIssue('/sources/include', 'Expected a non-empty array of globs')]
      : []),
    ...arrayItemIssues(sources.include, '/sources/include', globItemIssues),
    ...arrayItemIssues(sources.categories, '/sources/categories', (item, itemPath) =>
      objectItemIssues(item, itemPath, CATEGORY_RULE_FIELDS),
    ),
  ];
}

function imageProfileIssues(profile: RawConfigObject, path: string): ConfigIssue[] {
  const hasTransformation = profile.resize !== undefined || profile.webp !== undefined;
  return [
    ...fieldIssues(profile, path, IMAGE_PROFILE_FIELDS),
    ...(hasTransformation
      ? []
      : [configIssue(path, 'An image profile needs resize, webp or both; use "copy" otherwise')]),
    ...nestedObjectIssues(profile.resize, `${path}/resize`, (resize) =>
      fieldIssues(resize, `${path}/resize`, RESIZE_FIELDS),
    ),
    ...nestedObjectIssues(profile.webp, `${path}/webp`, (webp) =>
      fieldIssues(webp, `${path}/webp`, WEBP_FIELDS),
    ),
  ];
}

function profileIssues(name: string, profile: unknown): ConfigIssue[] {
  const path = childPath('/profiles', name);
  if (!isSlug(name) || name === BUILT_IN_COPY_PROFILE) {
    return [configIssue(path, 'Profile names are lowercase slugs; "copy" is built in')];
  }
  if (!isPlainObject(profile)) return [configIssue(path, 'Expected an object')];
  if (profile.kind === 'copy') return fieldIssues(profile, path, COPY_PROFILE_FIELDS);
  if (profile.kind === 'image') return imageProfileIssues(profile, path);
  return [configIssue(`${path}/kind`, 'Expected "copy" or "image"')];
}

/** Shape issues of the optional `profiles` map and `profileRules` list. */
export function profileSectionIssues(profiles: unknown, profileRules: unknown): ConfigIssue[] {
  return [
    ...nestedObjectIssues(profiles, '/profiles', (definitions) =>
      Object.entries(definitions).flatMap(([name, profile]) => profileIssues(name, profile)),
    ),
    ...arrayItemIssues(profileRules, '/profileRules', (item, itemPath) =>
      objectItemIssues(item, itemPath, PROFILE_RULE_FIELDS),
    ),
  ];
}
