/** One literal/class predicate or a wildcard spanning zero or more sequence units. */
export type WildcardStep =
  { readonly kind: 'many' } | { readonly kind: 'one'; readonly matches: (unit: string) => boolean };

/** Includes positions reachable when a repeated wildcard consumes nothing. */
function withEmptyWildcards(
  states: ReadonlySet<number>,
  patterns: readonly WildcardStep[],
): Set<number> {
  const reachable = new Set(states);
  for (const index of reachable) {
    if (patterns[index]?.kind === 'many') reachable.add(index + 1);
  }
  return reachable;
}

function statesAfterUnit(
  unit: string,
  states: ReadonlySet<number>,
  patterns: readonly WildcardStep[],
): Set<number> {
  const next = new Set<number>();
  for (const index of states) {
    const pattern = patterns[index];
    if (pattern?.kind === 'many') next.add(index);
    else if (pattern?.matches(unit)) next.add(index + 1);
  }
  return withEmptyWildcards(next, patterns);
}

/**
 * Tracks reachable pattern positions rather than backtracking: time is bounded by pattern
 * length times unit count, memory by pattern length. Units are path segments or Unicode code
 * points; predicates match exactly one unit and contain no repeating regular expressions.
 */
export function matchesWildcardSequence(
  patterns: readonly WildcardStep[],
  units: Iterable<string>,
): boolean {
  let states = withEmptyWildcards(new Set([0]), patterns);
  for (const unit of units) states = statesAfterUnit(unit, states, patterns);
  return states.has(patterns.length);
}
