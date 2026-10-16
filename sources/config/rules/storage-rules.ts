import type { ConfigIssue } from '../pipeline-config.ts';
import {
  configIssue,
  fieldIssues,
  isEnvName,
  isCheckedByNestedRules,
  isOneOf,
  nestedObjectIssues,
} from './field-rules.ts';
import type { FieldRule, RawConfigObject } from './field-rules.ts';

const ENV_NAME_EXPECTATION = 'Expected an environment variable name such as R2_BUCKET';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hasOnlyOriginAndPath(url: URL): boolean {
  return [url.username, url.password, url.search, url.hash].every((part) => part === '');
}

/** HTTPS, or plain HTTP only to a loopback test server. */
function hasAcceptableScheme(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function isPublicBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return hasAcceptableScheme(url) && hasOnlyOriginAndPath(url);
}

function envNameRule(key: string, isRequired: boolean): FieldRule {
  return { key, isValid: isEnvName, expectation: ENV_NAME_EXPECTATION, isRequired };
}

const CREDENTIAL_RULES: readonly FieldRule[] = [
  envNameRule('accessKeyIdEnv', true),
  envNameRule('secretAccessKeyEnv', true),
];

const PUBLIC_HTTP_RULES: readonly FieldRule[] = [
  { key: 'transport', isValid: isOneOf(['public-http']), expectation: 'Expected "public-http"' },
  {
    key: 'publicBaseUrl',
    isValid: isPublicBaseUrl,
    expectation:
      'Expected an https URL (http only to a loopback host) without user info, query or fragment',
    isRequired: true,
  },
];

const S3_READONLY_RULES: readonly FieldRule[] = [
  { key: 'transport', isValid: isOneOf(['s3-readonly']), expectation: 'Expected "s3-readonly"' },
  ...CREDENTIAL_RULES,
];

const R2_RULES: readonly FieldRule[] = [
  envNameRule('endpointEnv', false),
  envNameRule('bucketEnv', false),
  { key: 'writer', isValid: isCheckedByNestedRules, expectation: '' },
  { key: 'read', isValid: isCheckedByNestedRules, expectation: '' },
];

function readTransportIssues(read: RawConfigObject): ConfigIssue[] {
  if (read.transport === 'public-http') return fieldIssues(read, '/r2/read', PUBLIC_HTTP_RULES);
  if (read.transport === 's3-readonly') return fieldIssues(read, '/r2/read', S3_READONLY_RULES);
  return [configIssue('/r2/read/transport', 'Expected "public-http" or "s3-readonly"')];
}

/** Shape issues of the optional `r2` section: env-name references and the read transport. */
export function r2SectionIssues(r2: RawConfigObject): ConfigIssue[] {
  return [
    ...fieldIssues(r2, '/r2', R2_RULES),
    ...nestedObjectIssues(r2.writer, '/r2/writer', (writer) =>
      fieldIssues(writer, '/r2/writer', CREDENTIAL_RULES),
    ),
    ...nestedObjectIssues(r2.read, '/r2/read', readTransportIssues),
  ];
}
