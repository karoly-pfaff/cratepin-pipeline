/**
 * Orders strings by UTF-16 code units, the same on every machine and locale, unlike
 * `localeCompare`; inventories and locks must sort identically everywhere.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Sorts by `path`, then by `code` when present; returns a new array. */
export function sortedByPath<Item extends { readonly path: string; readonly code?: string }>(
  items: readonly Item[],
): Item[] {
  return items.toSorted(
    (left, right) =>
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.code ?? '', right.code ?? ''),
  );
}
