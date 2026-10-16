const REDACTED = '[REDACTED]';
/** Shorter known secrets are redacted only as whole words, so they cannot shred ordinary text. */
export const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * A query parameter of a signed storage URL (S3 and R2 presigned, Azure SAS, generic tokens), as
 * the config and the manifest scans refuse it; report redaction removes such values separately.
 */
export const SIGNED_URL_QUERY_PARAMETER =
  /[?&](?:X-Amz-[\w-]+|Signature|Expires|token|sig|se|sp)=/iu;

/**
 * Credential shapes that are unambiguous anywhere. Hex keys (R2 access keys are 32 and 64 hex
 * characters) are deliberately absent: SHA-256 digests have the same shape and are legitimate
 * report content, so real key values are redacted through the redaction context instead.
 */
export const CREDENTIAL_TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,
];

/** Secret values resolved for this run; built by whoever resolved credentials, never omitted. */
export interface RedactionContext {
  readonly knownSecretValues: readonly string[];
}

/** For runs that resolved no credentials, such as offline or purely local commands. */
export const NO_RESOLVED_SECRETS: RedactionContext = { knownSecretValues: [] };

/**
 * Collects the secret values one run resolves, so the report of that run redacts them wherever
 * they appear. Whoever resolves a credential remembers it here before using it.
 */
export class ResolvedSecrets {
  private readonly values = new Set<string>();

  remember(value: string): void {
    if (value !== '') this.values.add(value);
  }

  get redactionContext(): RedactionContext {
    return { knownSecretValues: [...this.values] };
  }
}

const SIGNED_URL_PARAMETERS =
  'X-Amz-Credential|X-Amz-Signature|X-Amz-Security-Token|token|signature|sig';
const SECRET_HEADER_NAME = '(?:proxy-)?authorization|x-amz-security-token';
const CREDENTIAL_ENV_NAME = '[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|ACCESS_KEY)[A-Z0-9_]*';
const SIGNING_XML_TAGS =
  'AWSAccessKeyId|SignatureProvided|StringToSign|StringToSignBytes|CanonicalRequest|CanonicalRequestBytes';

/** `name: value`, `name=value`, `"name": "value"`: the name group must be the second group. */
function quotedAssignment(namePattern: string, flags: string): RegExp {
  return new RegExp(`(["']?)(${namePattern})\\1(\\s*[:=]\\s*)(["'])[^"'\\n]*\\4`, flags);
}

function unquotedAssignment(namePattern: string, valuePattern: string, flags: string): RegExp {
  return new RegExp(`(${namePattern})(\\s*[:=]\\s*)(?!["'])${valuePattern}`, flags);
}

const SECRET_TEXT_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [quotedAssignment(`(?<![\\w/.-])${SECRET_HEADER_NAME}`, 'gi'), `$1$2$1$3$4${REDACTED}$4`],
  [unquotedAssignment(`(?<![\\w/.-])${SECRET_HEADER_NAME}`, '[^\\n]+', 'gi'), `$1$2${REDACTED}`],
  [/(?<=[\s,])(Credential|Signature)=[^,\s&"']+/g, `$1=${REDACTED}`],
  [new RegExp(`([?&](?:${SIGNED_URL_PARAMETERS})=)[^&\\s"']+`, 'gi'), `$1${REDACTED}`],
  [/(\/\/)[^/\s]*@/g, `$1${REDACTED}@`],
  [quotedAssignment(`\\b${CREDENTIAL_ENV_NAME}`, 'g'), `$1$2$1$3$4${REDACTED}$4`],
  // Every value is redacted: hiding a harmless variable name beats exempting a secret by shape.
  [unquotedAssignment(`\\b${CREDENTIAL_ENV_NAME}`, '\\S+', 'g'), `$1$2${REDACTED}`],
  [new RegExp(`<(${SIGNING_XML_TAGS})>[^<]*</`, 'g'), `<$1>${REDACTED}</`],
  ...CREDENTIAL_TOKEN_PATTERNS.map(
    (pattern) => [new RegExp(pattern.source, `${pattern.flags}g`), REDACTED] as const,
  ),
];

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Long values are replaced anywhere; short ones only as whole words, so prose survives. */
function redactKnownValue(text: string, secret: string): string {
  if (secret.length >= MIN_KNOWN_SECRET_LENGTH) return text.split(secret).join(REDACTED);
  const wholeWord = new RegExp(`(?<!\\w)${escapeForRegExp(secret)}(?!\\w)`, 'g');
  return text.replace(wholeWord, REDACTED);
}

function replaceKnownValues(text: string, knownSecretValues: readonly string[]): string {
  return knownSecretValues.filter((secret) => secret.length > 0).reduce(redactKnownValue, text);
}

/**
 * Removes credentials from one piece of text: authorization and session-token headers (also
 * JSON-quoted), SigV4 credential/signature fields, signed URL parameters, URL user info,
 * credential environment assignments, S3 signing details in error XML, unambiguous credential
 * tokens and the run's resolved secret values. Apply it to raw strings, never to serialized JSON.
 */
export function redactSecrets(text: string, context: RedactionContext): string {
  const withoutKnownValues = replaceKnownValues(text, context.knownSecretValues);
  return SECRET_TEXT_REPLACEMENTS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    withoutKnownValues,
  );
}
