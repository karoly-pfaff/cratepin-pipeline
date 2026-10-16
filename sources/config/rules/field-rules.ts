import type { ConfigIssue } from '../pipeline-config.ts';
import { issuePathSegmentFor } from './secret-shapes.ts';

export type RawConfigObject = Readonly<Record<string, unknown>>;
export type ValuePredicate = (value: unknown) => boolean;

/** One allowed field of a config object; fields without a rule are reported as unknown. */
export interface FieldRule {
  readonly key: string;
  readonly isValid: ValuePredicate;
  readonly expectation: string;
  readonly isRequired?: boolean;
}

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isPlainObject(value: unknown): value is RawConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** For fields whose shape a nested check reports, so the field is known but not judged twice. */
export function isCheckedByNestedRules(): boolean {
  return true;
}

export function isBoolean(value: unknown): boolean {
  return typeof value === 'boolean';
}

export function isEnvName(value: unknown): boolean {
  return typeof value === 'string' && ENV_NAME_PATTERN.test(value);
}

export function isSlug(value: unknown): boolean {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

export function isIntegerBetween(minimum: number, maximum: number): ValuePredicate {
  return (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function isOneOf(allowedValues: readonly unknown[]): ValuePredicate {
  return (value) => allowedValues.includes(value);
}

/** The issue path of a child field: credential-shaped keys never appear in output. */
export function childPath(path: string, key: string): string {
  return `${path}/${issuePathSegmentFor(key)}`;
}

export function configIssue(
  path: string,
  message: string,
  code: ConfigIssue['code'] = 'CONFIG_INVALID',
): ConfigIssue {
  return { path: path === '' ? '/' : path, code, message };
}

function ruleIssues(fields: RawConfigObject, path: string, rule: FieldRule): ConfigIssue[] {
  const value = fields[rule.key];
  const fieldPath = `${path}/${rule.key}`;
  if (value === undefined) {
    return rule.isRequired ? [configIssue(fieldPath, 'Missing required field')] : [];
  }
  return rule.isValid(value) ? [] : [configIssue(fieldPath, rule.expectation)];
}

/** Unknown keys plus every rule violation of one config object. */
export function fieldIssues(
  fields: RawConfigObject,
  path: string,
  rules: readonly FieldRule[],
): ConfigIssue[] {
  const knownKeys = new Set(rules.map((rule) => rule.key));
  const unknownKeyIssues = Object.keys(fields)
    .filter((key) => !knownKeys.has(key))
    .map((key) => configIssue(childPath(path, key), 'Unknown field'));
  return [...unknownKeyIssues, ...rules.flatMap((rule) => ruleIssues(fields, path, rule))];
}

/** Issues of an optional nested object; absent means "use the default". */
export function nestedObjectIssues(
  value: unknown,
  path: string,
  issuesOfObject: (fields: RawConfigObject) => ConfigIssue[],
): ConfigIssue[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return [configIssue(path, 'Expected an object')];
  return issuesOfObject(value);
}

/** Issues of an optional array whose items are all checked by `issuesOfItem`. */
export function arrayItemIssues(
  value: unknown,
  path: string,
  issuesOfItem: (item: unknown, itemPath: string) => ConfigIssue[],
): ConfigIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [configIssue(path, 'Expected an array')];
  return value.flatMap((item: unknown, index) => issuesOfItem(item, `${path}/${String(index)}`));
}

/** Issues of an array item that must be an object following `rules`. */
export function objectItemIssues(
  item: unknown,
  itemPath: string,
  rules: readonly FieldRule[],
): ConfigIssue[] {
  if (!isPlainObject(item)) return [configIssue(itemPath, 'Expected an object')];
  return fieldIssues(item, itemPath, rules);
}
