import type { CredentialEnvNames, R2Settings } from '../../config/pipeline-config.ts';
import { PipelineError } from '../../errors.ts';
import type { ResolvedSecrets } from '../../redaction.ts';
import type { SigningCredentials } from './sig-v4.ts';

/** Environment variables as the process sees them; passed in so tests need no real ones. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** What one run may resolve from, and where it remembers resolved secrets for redaction. */
export interface RunEnvironment {
  readonly variables: EnvironmentVariables;
  readonly secrets: ResolvedSecrets;
}

/** What the caller is about to do: author uploads write, build-side retrieval reads. */
export type R2Access = 'write' | 'read';

/** Everything needed to sign requests against one R2 bucket. */
export interface R2Connection {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly credentials: SigningCredentials;
}

/** R2 bucket names: 3–63 lower-case letters, digits and hyphens, not starting or ending with `-`. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function configError(message: string, variable: string): PipelineError {
  return new PipelineError('CONFIG_INVALID', message, { variable });
}

/** HTTPS, or plain HTTP only to a loopback test server. */
function hasAcceptableScheme(endpoint: URL): boolean {
  if (endpoint.protocol === 'https:') return true;
  return endpoint.protocol === 'http:' && LOOPBACK_HOSTS.has(endpoint.hostname);
}

/**
 * Only scheme, host and port, or those followed by the bucket's own name, as the Cloudflare
 * dashboard shows a bucket's S3 API URL: no other path, no query, fragment or user info.
 */
function isAccountOrBucketUrl(endpoint: URL, bucket: string): boolean {
  const origin = `${endpoint.origin}/`;
  return [origin, `${origin}${bucket}`, `${origin}${bucket}/`].includes(endpoint.href);
}

function isAcceptableEndpoint(endpoint: URL, bucket: string): boolean {
  return hasAcceptableScheme(endpoint) && isAccountOrBucketUrl(endpoint, bucket);
}

type EndpointNames = Pick<R2Settings, 'endpointEnv' | 'bucketEnv'>;

/** The account endpoint the requests go to; a bucket-scoped URL is cut back to its origin. */
function endpointFrom(value: string, bucket: string, names: EndpointNames): URL {
  const endpoint = URL.canParse(value) ? new URL(value) : undefined;
  if (endpoint !== undefined && isAcceptableEndpoint(endpoint, bucket)) {
    return new URL(endpoint.origin);
  }
  throw configError(
    `The R2 endpoint must be an https URL such as https://<account>.r2.cloudflarestorage.com, optionally followed by /<the bucket in ${names.bucketEnv}>, without other path, query or credentials.`,
    names.endpointEnv,
  );
}

function bucketFrom(value: string, variable: string): string {
  if (BUCKET_NAME.test(value)) return value;
  throw configError(
    'The R2 bucket name must be 3–63 lower-case letters, digits or hyphens.',
    variable,
  );
}

function credentialNamesFor(r2: R2Settings, access: R2Access): CredentialEnvNames {
  if (access === 'write') return r2.writer;
  if (r2.read.transport === 's3-readonly') return r2.read;
  throw new PipelineError(
    'CONFIG_INVALID',
    'The public-http read transport uses no S3 credentials.',
    { transport: 'public-http' },
  );
}

/** The values of the named variables, failing with every missing name and no value. */
function requiredValues(environment: EnvironmentVariables, names: readonly string[]): string[] {
  const missing = names.filter((name) => (environment[name] ?? '') === '');
  if (missing.length > 0) {
    throw new PipelineError('CONFIG_INVALID', 'Required environment variables are not set.', {
      missing: missing.join(', '),
    });
  }
  return names.map((name) => environment[name] ?? '');
}

/**
 * Resolves the endpoint, bucket and the credentials `access` needs, only when a transfer is about
 * to happen: nothing reads the environment earlier. The writer key is resolved only for `write`.
 * Resolved key values are remembered in `secrets` so every report redacts them.
 */
export function resolveR2Connection(
  r2: R2Settings,
  access: R2Access,
  { variables, secrets }: RunEnvironment,
): R2Connection {
  const keyNames = credentialNamesFor(r2, access);
  const names = [
    r2.endpointEnv,
    r2.bucketEnv,
    keyNames.accessKeyIdEnv,
    keyNames.secretAccessKeyEnv,
  ];
  const [endpointValue = '', bucketValue = '', accessKeyId = '', secretAccessKey = ''] =
    requiredValues(variables, names);
  secrets.remember(accessKeyId);
  secrets.remember(secretAccessKey);
  const bucket = bucketFrom(bucketValue, r2.bucketEnv);
  return {
    endpoint: endpointFrom(endpointValue, bucket, r2),
    bucket,
    credentials: { accessKeyId, secretAccessKey },
  };
}
