import { CREDENTIAL_TOKEN_PATTERNS, SIGNED_URL_QUERY_PARAMETER } from '../../redaction.ts';

/**
 * Values that must never appear in a config file. Unlike report redaction, hex keys are rejected
 * by shape here: R2 access keys are 32 and 64 hex characters and a config has no digest fields.
 */
const CONFIG_SECRET_PATTERNS: readonly RegExp[] = [
  ...CREDENTIAL_TOKEN_PATTERNS,
  // Hex runs bounded by non-hex characters, so `p_<hex>` and `prefix/<hex>` are found too.
  /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i,
  /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i,
  SIGNED_URL_QUERY_PARAMETER,
];

const REDACTED_KEY_SEGMENT = '[REDACTED]';

function hasUrlUserInfo(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return url.username !== '' || url.password !== '';
}

/** Cloudflare's public bucket host: the hex is a public bucket id, not a key. */
const R2_PUBLIC_BUCKET_HOST = /^pub-[0-9a-f]{32}\.r2\.dev$/i;

/**
 * The part of a value that may carry a secret: everything, except the host of an
 * `https://pub-<32 hex>.r2.dev` URL, which is the standard public R2 address.
 */
function secretBearingPart(text: string): string {
  if (!URL.canParse(text)) return text;
  const url = new URL(text);
  const isR2PublicBucketUrl = url.protocol === 'https:' && R2_PUBLIC_BUCKET_HOST.test(url.hostname);
  return isR2PublicBucketUrl ? `${url.pathname}${url.search}${url.hash}` : text;
}

export function isSecretLike(text: string): boolean {
  const scannedText = secretBearingPart(text);
  return (
    hasUrlUserInfo(text) || CONFIG_SECRET_PATTERNS.some((pattern) => pattern.test(scannedText))
  );
}

/** A config key as it may appear in an issue path: credential-shaped keys are never echoed. */
export function issuePathSegmentFor(key: string): string {
  return isSecretLike(key) ? REDACTED_KEY_SEGMENT : key;
}
