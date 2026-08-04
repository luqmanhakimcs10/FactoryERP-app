/**
 * Shared substring matcher for the dashboards' section search.
 *
 * One definition so every dashboard filters its navigation cards identically —
 * case-insensitive, whitespace-tolerant, and matching against every field the
 * caller passes rather than the title alone (searching "inventory" should find
 * the Orders card, whose subtitle is where that word lives).
 *
 * An empty query matches everything: the search bar is a filter, not a gate.
 */
export function matchesSearch(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}
