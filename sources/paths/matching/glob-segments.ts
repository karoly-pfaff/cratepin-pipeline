import { matchesWildcardSequence } from './wildcard-sequence.ts';
import type { WildcardStep } from './wildcard-sequence.ts';

const REGEXP_SYNTAX = /[$()*+.?[\\\]^{|}]/gu;
const CLASS_SYNTAX = /[[\\\]^]/gu;

/** `[a-z]` stays a class; `[!x]` and `[^x]` are negated; `-` keeps its range meaning. */
function classSource(token: string): string {
  const body = token.slice(1, -1);
  const isNegated = body.length > 1 && (body.startsWith('!') || body.startsWith('^'));
  const members = (isNegated ? body.slice(1) : body).replaceAll(CLASS_SYNTAX, '\\$&');
  return `[${isNegated ? '^' : ''}${members}]`;
}

function tokenSource(token: string): string {
  if (token === '?') return '.';
  return token.length > 2 && token.startsWith('[')
    ? classSource(token)
    : token.replaceAll(REGEXP_SYNTAX, '\\$&');
}

/** A class starting here, or one whole Unicode code point, never half a surrogate pair. */
function tokenAt(segment: string, index: number): string {
  const character = String.fromCodePoint(segment.codePointAt(index) ?? 0);
  if (character !== '[') return character;
  const classEnd = segment.indexOf(']', index + 2);
  return classEnd < 0 ? character : segment.slice(index, classEnd + 1);
}

function globTokens(segment: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < segment.length) {
    const token = tokenAt(segment, index);
    tokens.push(token);
    index += token.length;
  }
  return tokens;
}

function compileToken(token: string): WildcardStep {
  if (token === '*') return { kind: 'many' };
  const character = new RegExp(`^(?:${tokenSource(token)})$`, 'isu');
  return { kind: 'one', matches: (unit) => character.test(unit) };
}

/** Stars span code points; literal/class regexes consume only one and cannot backtrack stars. */
export function compileSegmentName(segment: string): (name: string) => boolean {
  const patterns = globTokens(segment).map(compileToken);
  return (name) => matchesWildcardSequence(patterns, name);
}
