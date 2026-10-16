import { duplicateKeyPaths } from './duplicate-keys.ts';

/** Where a JSON document is malformed, as a JSON pointer-like path and a message. */
interface JsonProblem {
  readonly path: string;
  readonly message: string;
}

export type StrictJsonParse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problems: readonly JsonProblem[] };

const DUPLICATE_FIELD_MESSAGE = 'Duplicate field; JSON would silently keep only the last value';

function parseJson(text: string): { readonly isJson: boolean; readonly value: unknown } {
  try {
    return { isJson: true, value: JSON.parse(text) };
  } catch {
    return { isJson: false, value: undefined };
  }
}

/**
 * Parses JSON and refuses a field that appears twice in one object: plain `JSON.parse` keeps only
 * the last value, which could hide an earlier one (for example a pasted credential).
 */
export function parseStrictJson(text: string): StrictJsonParse {
  const parsed = parseJson(text);
  if (!parsed.isJson)
    return { ok: false, problems: [{ path: '/', message: 'File is not valid JSON' }] };
  const problems = duplicateKeyPaths(text).map((path) => ({
    path,
    message: DUPLICATE_FIELD_MESSAGE,
  }));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: parsed.value };
}

/** A parsed JSON object (not an array or null), whose fields are still unchecked. */
export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
