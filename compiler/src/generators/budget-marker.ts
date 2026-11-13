// Shared text of a domain-budget obligation marker.
// Kept off the Z3 generators so those modules do not import each other.

export function budgetKey(domainName: string): string {
  return `${domainName}.budget`;
}

/** `; speckl-unchecked: <key>: <reason>` — never a proof. */
export function uncheckedBudget(key: string, reason: string): string {
  const safe = reason.replace(/:\s/g, ' - ').replace(/\s+/g, ' ').trim();
  return `; speckl-unchecked: ${key}: ${safe}\n`;
}
