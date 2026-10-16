import { mediaTypeOf, suitsCategory } from '../catalog/media-types.ts';
import { compareCodeUnits } from '../catalog/ordering.ts';
import {
  isLicenceText,
  isLocale,
  isLogicalId,
  repeatedUseIssues,
} from '../config/rules/asset-rules.ts';
import type { FieldUse } from '../config/rules/asset-rules.ts';
import {
  arrayItemIssues,
  configIssue,
  fieldIssues,
  isCheckedByNestedRules,
  isIntegerBetween,
  isOneOf,
  isPlainObject,
  isSlug,
  objectItemIssues,
} from '../config/rules/field-rules.ts';
import type { FieldRule, RawConfigObject } from '../config/rules/field-rules.ts';
import { MEDIA_CATEGORIES } from '../config/pipeline-config.ts';
import type { ConfigIssue, ResourceLimits } from '../config/pipeline-config.ts';
import { isPortableRelativePath } from '../paths/portable-path.ts';
import { LOCK_SCHEMA_VERSION, objectKeyFor } from './source-lock.ts';
import type { LockNamespace, SourceLock, SourceRecord } from './source-lock.ts';

/** `LOCK_UNSUPPORTED`: a newer schema version than this tool reads; `LOCK_INVALID`: anything else. */
export interface LockIssue {
  readonly path: string;
  readonly code: 'LOCK_INVALID' | 'LOCK_UNSUPPORTED';
  readonly message: string;
}

export type LockValidation =
  | { readonly ok: true; readonly lock: SourceLock }
  | { readonly ok: false; readonly issues: readonly LockIssue[] };

/** What a lock is checked against: this project's namespace and its source size limit. */
export type LockRules = LockNamespace & {
  readonly limits: Pick<ResourceLimits, 'maxSourceBytes'>;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): boolean {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function requiredField(key: string, isValid: FieldRule['isValid'], expectation: string): FieldRule {
  return { key, isValid, expectation, isRequired: true };
}

const LOCK_FIELDS: readonly FieldRule[] = [
  requiredField('schemaVersion', isOneOf([LOCK_SCHEMA_VERSION]), 'Expected 1'),
  requiredField('projectId', isSlug, 'Expected a project slug'),
  requiredField('assets', isCheckedByNestedRules, ''),
];

const RECORD_FIELDS: readonly FieldRule[] = [
  requiredField('id', isLogicalId, 'Expected a logical ID'),
  requiredField('source', isPortableRelativePath, 'Expected a portable path relative to sourceDir'),
  requiredField('sha256', isSha256Hex, 'Expected 64 lowercase hex digits'),
  requiredField('bytes', isIntegerBetween(0, Number.MAX_SAFE_INTEGER), 'Expected a byte count'),
  requiredField('mediaType', isNonEmptyString, 'Expected a media type'),
  requiredField(
    'category',
    isOneOf(MEDIA_CATEGORIES),
    `Expected one of ${MEDIA_CATEGORIES.join(', ')}`,
  ),
  requiredField('objectKey', isNonEmptyString, 'Expected an object key'),
  { key: 'locale', isValid: isLocale, expectation: 'Expected a language tag' },
  { key: 'role', isValid: isSlug, expectation: 'Expected a lowercase slug' },
  { key: 'profile', isValid: isSlug, expectation: 'Expected a profile name' },
  { key: 'licence', isValid: isLicenceText, expectation: 'Expected one line of licence text' },
];

function shapeIssues(raw: RawConfigObject): ConfigIssue[] {
  return [
    ...fieldIssues(raw, '', LOCK_FIELDS),
    ...arrayItemIssues(raw.assets, '/assets', (item, itemPath) =>
      objectItemIssues(item, itemPath, RECORD_FIELDS),
    ),
  ];
}

/** The extension decides the media type, and the media type must suit the category. */
function mediaTypeIssues(record: SourceRecord, path: string): ConfigIssue[] {
  const expectedMediaType = mediaTypeOf(record.source);
  if (expectedMediaType === undefined) {
    return [configIssue(`${path}/source`, 'The extension is not a supported media format')];
  }
  if (record.mediaType !== expectedMediaType) {
    return [configIssue(`${path}/mediaType`, `Expected ${expectedMediaType} for this source`)];
  }
  if (suitsCategory(record.category, record.mediaType)) return [];
  return [configIssue(`${path}/category`, 'The category does not suit the media type')];
}

/** A locked original larger than any original scan accepts is never retrieved or read. */
function sizeIssues(record: SourceRecord, path: string, rules: LockRules): ConfigIssue[] {
  if (record.bytes <= rules.limits.maxSourceBytes) return [];
  return [configIssue(`${path}/bytes`, 'Larger than limits.maxSourceBytes')];
}

/** The key must be this project's key for this hash, so an edited hash or key cannot pass. */
function recordConsistencyIssues(
  record: SourceRecord,
  index: number,
  rules: LockRules,
): ConfigIssue[] {
  const path = `/assets/${String(index)}`;
  const isOwnKey = record.objectKey === objectKeyFor(rules, record.sha256);
  return [
    ...sizeIssues(record, path, rules),
    ...(isOwnKey
      ? []
      : [
          configIssue(
            `${path}/objectKey`,
            'Expected this project’s key for sha256; the hash or key was edited',
          ),
        ]),
    ...mediaTypeIssues(record, path),
  ];
}

function usesOf(lock: SourceLock, field: 'id' | 'source'): FieldUse[] {
  return lock.assets.map((record, index) => ({
    path: `/assets/${String(index)}/${field}`,
    value: record[field],
  }));
}

const NAMESPACE_CHANGED_MESSAGE =
  'Every object key lies outside this project’s namespace: objectPrefix changed since the lock ' +
  'was written. Originals must be pushed again under the new keys: move this lock aside, then ' +
  'scan and push; the old objects stay stored.';

/** Each key has the content-addressed shape for its hash, but under another prefix. */
function isWholeLockUnderAnotherPrefix(lock: SourceLock, namespace: LockNamespace): boolean {
  return (
    lock.assets.length > 0 &&
    lock.assets.every(
      (record) =>
        record.objectKey !== objectKeyFor(namespace, record.sha256) &&
        record.objectKey.endsWith(
          `/projects/${namespace.projectId}/sources/sha256/${record.sha256}`,
        ),
    )
  );
}

function relationIssues(lock: SourceLock, namespace: LockRules): ConfigIssue[] {
  if (isWholeLockUnderAnotherPrefix(lock, namespace)) {
    return [configIssue('/assets', NAMESPACE_CHANGED_MESSAGE)];
  }
  if (lock.projectId !== namespace.projectId) {
    const message = `The lock belongs to project "${lock.projectId}", not "${namespace.projectId}"`;
    return [configIssue('/projectId', message)];
  }
  return [
    ...lock.assets.flatMap((record, index) => recordConsistencyIssues(record, index, namespace)),
    ...repeatedUseIssues(usesOf(lock, 'id'), 'This logical ID is already locked at'),
    ...repeatedUseIssues(usesOf(lock, 'source'), 'This source is already locked at'),
  ];
}

/** The field rules report config-style issues; in a lock they all mean LOCK_INVALID. */
function invalidLock(issues: readonly ConfigIssue[]): LockValidation {
  return { ok: false, issues: issues.map((issue) => ({ ...issue, code: 'LOCK_INVALID' })) };
}

/** An integer schema version above the one this tool reads: written by a newer tool. */
function isNewerSchemaVersion(version: unknown): boolean {
  return typeof version === 'number' && Number.isInteger(version) && version > LOCK_SCHEMA_VERSION;
}

const UNSUPPORTED_VERSION: LockIssue = {
  path: '/schemaVersion',
  code: 'LOCK_UNSUPPORTED',
  message: `This tool reads lock schemaVersion ${String(LOCK_SCHEMA_VERSION)}; a newer tool may have written this lock`,
};

/** Checks a lock whose shape is valid against the project and itself; sorts records by ID. */
function validateRelations(lock: SourceLock, namespace: LockRules): LockValidation {
  const relations = relationIssues(lock, namespace);
  if (relations.length > 0) return invalidLock(relations);
  const assets = lock.assets.toSorted((left, right) => compareCodeUnits(left.id, right.id));
  return { ok: true, lock: { ...lock, assets } };
}

/**
 * Validates parsed lock JSON for this project: the schema version must be one this tool reads,
 * unknown fields are errors, and every record's key, type and category must agree with its hash
 * and path, and no record may exceed `limits.maxSourceBytes`. Returns the lock with records sorted
 * by ID.
 */
export function validateLock(value: unknown, namespace: LockRules): LockValidation {
  if (!isPlainObject(value)) return invalidLock([configIssue('/', 'Expected an object')]);
  if (isNewerSchemaVersion(value.schemaVersion))
    return { ok: false, issues: [UNSUPPORTED_VERSION] };
  const shape = shapeIssues(value);
  if (shape.length > 0) return invalidLock(shape);
  return validateRelations(value as unknown as SourceLock, namespace);
}
