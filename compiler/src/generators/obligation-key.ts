// Shared naming for verify-block obligation markers in emitted SMT-LIB2.
// scripts/lib/obligations.mjs reads these markers.

/**
 * Stable name for a verify block in `speckl-obligation` / `speckl-unchecked`
 * markers. Old single-line `verify:` blocks are all named "unnamed", so they
 * get their position (1-based) to stay distinct. Shared with the IR backend.
 */
export function obligationKey(name: string, index: number): string {
  return name === 'unnamed' ? `unnamed#${index + 1}` : name;
}
