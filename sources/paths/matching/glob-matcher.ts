import { compileSegmentName } from './glob-segments.ts';
import { expandBraces, isPortableRelativeGlob } from '../portable-path.ts';
import { matchesWildcardSequence } from './wildcard-sequence.ts';
import type { WildcardStep } from './wildcard-sequence.ts';

function compileSegment(segment: string): WildcardStep {
  if (segment === '**') return { kind: 'many' };
  return { kind: 'one', matches: compileSegmentName(segment) };
}

/** Every brace alternative as segment patterns, or undefined when a class cannot compile. */
function compileAlternatives(glob: string): WildcardStep[][] | undefined {
  const alternatives = expandBraces(glob.normalize('NFC'));
  try {
    return alternatives?.map((alternative) => alternative.split('/').map(compileSegment));
  } catch {
    return undefined;
  }
}

/** A portable relative glob that also compiles, e.g. no reversed range such as `[b-a]`. */
export function isUsableGlob(value: unknown): value is string {
  return isPortableRelativeGlob(value) && compileAlternatives(value) !== undefined;
}

/**
 * Compiles the portable dialect with bounded wildcard matching, Unicode simple case folding
 * and NFC normalization. The same state algorithm spans path segments for `**` and individual
 * Unicode code points for `*`; no wildcard becomes a repeating regular expression.
 */
export function compileGlob(glob: string): (path: string) => boolean {
  const compiled = compileAlternatives(glob);
  if (compiled === undefined) throw new Error('Globs are validated before matching.');
  return (path) => {
    const segments = path.normalize('NFC').split('/');
    return compiled.some((patterns) => matchesWildcardSequence(patterns, segments));
  };
}
