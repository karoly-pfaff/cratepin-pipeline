import { caseFoldedPath, isPortableRelativePath } from '../../paths/portable-path.ts';
import { arrayItemIssues, configIssue, isOneOf, isSlug, objectItemIssues } from './field-rules.ts';
import type { FieldRule } from './field-rules.ts';
import { findProfile, MEDIA_CATEGORIES } from '../pipeline-config.ts';
import type { ConfigIssue, PipelineConfig } from '../pipeline-config.ts';

/** A language tag such as `en`, `hu` or `pt-BR`. */
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i;
const MAX_TEXT_LENGTH = 200;
/** Control, invisible formatting (such as bidi overrides) and line or paragraph separators. */
const HIDDEN_OR_LINE_BREAKING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function isLocale(value: unknown): boolean {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH && LOCALE_PATTERN.test(value);
}

/** Free licence text such as `CC-BY-4.0`: one trimmed line of at most 200 characters. */
export function isLicenceText(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) return false;
  return value !== '' && value.trim() === value && !HIDDEN_OR_LINE_BREAKING.test(value);
}

/**
 * Logical IDs follow the portable path rules, so `character.cat` and `images/cat` both work, and
 * are in composed Unicode form (NFC), so one ID has the same bytes on every machine.
 */
export function isLogicalId(value: unknown): value is string {
  if (!isPortableRelativePath(value) || value.length > MAX_TEXT_LENGTH) return false;
  return value === value.normalize('NFC');
}

const ASSET_FIELDS: readonly FieldRule[] = [
  {
    key: 'source',
    isValid: isPortableRelativePath,
    expectation: 'Expected the portable path of a file relative to sourceDir',
    isRequired: true,
  },
  {
    key: 'id',
    isValid: isLogicalId,
    expectation: 'Expected a logical ID in NFC form such as "character.cat" or "images/cat"',
  },
  {
    key: 'category',
    isValid: isOneOf(MEDIA_CATEGORIES),
    expectation: `Expected one of ${MEDIA_CATEGORIES.join(', ')}`,
  },
  { key: 'locale', isValid: isLocale, expectation: 'Expected a language tag such as "en"' },
  { key: 'role', isValid: isSlug, expectation: 'Expected a lowercase slug such as "actor"' },
  { key: 'profile', isValid: isSlug, expectation: 'Expected a profile name' },
  {
    key: 'licence',
    isValid: isLicenceText,
    expectation: 'Expected licence text of 1–200 characters on one line',
  },
];

/** Shape issues of the optional `assets` list of per-file metadata. */
export function assetSectionIssues(assets: unknown): ConfigIssue[] {
  return arrayItemIssues(assets, '/assets', (item, itemPath) =>
    objectItemIssues(item, itemPath, ASSET_FIELDS),
  );
}

export interface FieldUse {
  readonly path: string;
  readonly value: string;
}

/** An issue at every repeated use, ignoring letter case and Unicode form like the file systems. */
export function repeatedUseIssues(uses: readonly FieldUse[], what: string): ConfigIssue[] {
  const firstUseByKey = new Map<string, FieldUse>();
  return uses.flatMap((use) => {
    const key = caseFoldedPath(use.value);
    const firstUse = firstUseByKey.get(key);
    if (firstUse === undefined) firstUseByKey.set(key, use);
    return firstUse === undefined ? [] : [configIssue(use.path, `${what} ${firstUse.path}`)];
  });
}

function usesOf(config: PipelineConfig, field: 'source' | 'id' | 'profile'): FieldUse[] {
  return config.assets.flatMap((entry, index) => {
    const value = entry[field];
    return value === undefined ? [] : [{ path: `/assets/${String(index)}/${field}`, value }];
  });
}

/** One entry per source, unique logical IDs, and only profiles that exist. */
export function assetRelationIssues(config: PipelineConfig): ConfigIssue[] {
  const unknownProfiles = usesOf(config, 'profile').filter(
    (use) => findProfile(config, use.value) === undefined,
  );
  return [
    ...repeatedUseIssues(usesOf(config, 'source'), 'This source already has an entry at'),
    ...repeatedUseIssues(usesOf(config, 'id'), 'This logical ID is already used at'),
    ...unknownProfiles.map((use) => configIssue(use.path, `Unknown profile "${use.value}"`)),
  ];
}
