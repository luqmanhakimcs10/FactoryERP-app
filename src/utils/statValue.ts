/**
 * Formatting for the Key Metrics Grid.
 *
 * `StatCard` takes a STRING and never invents or rounds a number — which means
 * every caller has to decide what "not loaded yet" looks like. Nine dashboards
 * making that decision nine times is nine chances for one of them to render a
 * confident `0` over a query that has not answered yet, which is the one thing
 * a metrics grid must never do.
 */

/** A count. `—` while unknown, so an empty queue and a pending read differ. */
export function statCount(v: number | null | undefined): string {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : String(v);
}

/**
 * Money, short enough for a card. 12,500 -> "12.5K"; 2,400,000 -> "24L".
 *
 * Lakhs rather than millions above 1,00,000: this is a Pakistani factory, and
 * the figures are read out loud by people who count in lakhs.
 */
export function statMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 100000) return `${trim(n / 100000)}L`;
  if (abs >= 1000) return `${trim(n / 1000)}K`;
  return String(Math.round(n));
}

/** One decimal, but only when it says something: 2.0 -> "2", 2.4 -> "2.4". */
function trim(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** A big count, shortened the same way: 1,240 -> "1.2K". */
export function statBigCount(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Math.abs(Number(v)) >= 10000 ? statMoney(v) : String(Math.round(Number(v)));
}
