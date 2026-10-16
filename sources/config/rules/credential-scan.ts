import type { ConfigIssue } from '../pipeline-config.ts';
import { childPath, configIssue, isPlainObject } from './field-rules.ts';
import type { RawConfigObject } from './field-rules.ts';
import { isSecretLike } from './secret-shapes.ts';

const SECRET_MESSAGE =
  'Looks like a credential or signed URL; store an environment variable name instead';

function secretIssueAt(path: string): ConfigIssue {
  return configIssue(path, SECRET_MESSAGE, 'CONFIG_SECRET');
}

function secretIssuesInObject(fields: RawConfigObject, path: string): ConfigIssue[] {
  return Object.entries(fields).flatMap(([key, item]) => {
    const itemPath = childPath(path, key);
    const keyIssues = isSecretLike(key) ? [secretIssueAt(itemPath)] : [];
    return [...keyIssues, ...credentialShapedIssues(item, itemPath)];
  });
}

/** Every string (keys included) that looks like a credential, reported without its value. */
export function credentialShapedIssues(value: unknown, path = ''): ConfigIssue[] {
  if (typeof value === 'string') return isSecretLike(value) ? [secretIssueAt(path)] : [];
  if (isPlainObject(value)) return secretIssuesInObject(value, path);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown, index) =>
    credentialShapedIssues(item, `${path}/${String(index)}`),
  );
}
