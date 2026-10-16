/** One signal that aborts when any of the given ones does; `undefined` when none is given. */
export function eitherSignal(
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((signal) => signal !== undefined);
  return present.length === 0 ? undefined : AbortSignal.any(present);
}
