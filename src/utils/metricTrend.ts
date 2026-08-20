/**
 * Month-on-month series for a metric card, derived from rows already fetched.
 *
 * THE RULE THIS ENFORCES: a sparkline may only plot the SAME quantity the card
 * prints. A card reading "Active orders: 32" cannot carry a line of
 * orders-captured-per-month — that is a different number wearing the same
 * label, and it is the easiest way to publish a convincing lie.
 *
 * So there are two shapes, and callers pick by what their figure means:
 *
 *   cumulativeTrend  the card shows a RUNNING TOTAL ("total factories",
 *                    "damage records"). The series is that total at the end of
 *                    each past month, which is the same quantity over time.
 *
 *   periodTrend      the card shows THIS PERIOD'S total ("invoiced this
 *                    month"). The series is each month's own total.
 *
 * A live queue depth ("pending stage QA") fits neither: nothing recorded what it
 * was in April. Those cards pass no trend and render without one.
 *
 * Everything here works on rows the dashboard has already loaded — no extra
 * query, no new table.
 */
import type { MetricDelta } from '../components/ui/MetricCard';

/** `YYYY-MM` for a date, in local time — these are calendar months, not UTC. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The last `n` month keys, oldest first, ending with the current month. */
function lastMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(monthKey(m));
  }
  return out;
}

function delta(series: number[]): MetricDelta | null {
  if (series.length < 2) return null;
  const now = series[series.length - 1];
  const before = series[series.length - 2];
  // No baseline means no percentage. "Up from nothing" is not 100% growth, it
  // is a first entry, and printing a number for it would be inventing one.
  if (!before) return null;
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  if (pct === 0) return null;
  return { pct: Math.abs(pct), direction: pct > 0 ? 'up' : 'down' };
}

export interface Trend {
  trend: number[] | null;
  delta: MetricDelta | null;
}

const EMPTY: Trend = { trend: null, delta: null };

/**
 * Is this series worth drawing?
 *
 * A factory three weeks old produces 0,0,0,0,0,2 for everything. Plotted, that
 * is a flat rule along the bottom and one spike — which reads as a rendering
 * artefact, not as a trend, and says nothing the printed figure did not. Worse,
 * the five zeroes are "we were not open yet", not "we made nothing", and a
 * chart cannot draw that distinction.
 *
 * So a line needs THREE months that actually happened and more than one
 * distinct value. Below that the card shows its number and no chart, and the
 * lines appear on their own as the months accumulate.
 */
function worthPlotting(series: number[]): boolean {
  const live = series.filter((v) => v !== 0).length;
  const distinct = new Set(series).size;
  return live >= 3 && distinct >= 2;
}

/**
 * Running total at the end of each of the last `months` months.
 *
 * For a card whose figure is a cumulative count of rows that each carry a
 * creation timestamp.
 */
export function cumulativeTrend<T>(
  rows: T[] | undefined | null,
  when: (row: T) => string | null | undefined,
  months = 6
): Trend {
  if (!rows) return EMPTY;

  const keys = lastMonths(months);
  const stamps = rows
    .map(when)
    .filter(Boolean)
    .map((s) => new Date(s as string))
    .filter((d) => !Number.isNaN(d.getTime()));

  const series = keys.map((k) => {
    // Everything created on or before the END of that month.
    const [y, m] = k.split('-').map(Number);
    const end = new Date(y, m, 1).getTime();
    return stamps.filter((d) => d.getTime() < end).length;
  });

  // The delta survives even when the line does not: "2 more than last month"
  // is true and useful on a young dataset; six plotted months are not.
  return { trend: worthPlotting(series) ? series : null, delta: delta(series) };
}

/**
 * Each month's own total, over the last `months` months.
 *
 * `amount` defaults to counting rows; pass it to sum a money column instead.
 *
 * FEED THIS UNFILTERED ROWS. A month with no matching row is plotted as zero,
 * which is true only if the rows you passed cover every month in the window.
 * Hand it the output of a period-scoped query and it draws five months of
 * confident zeroes that the query's own WHERE clause invented — which is worse
 * than no chart, because it looks like evidence.
 */
export function periodTrend<T>(
  rows: T[] | undefined | null,
  when: (row: T) => string | null | undefined,
  months = 6,
  amount?: (row: T) => number
): Trend {
  if (!rows) return EMPTY;

  const keys = lastMonths(months);
  const buckets = new Map<string, number>(keys.map((k) => [k, 0]));

  for (const row of rows) {
    const raw = when(row);
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    const k = monthKey(d);
    if (!buckets.has(k)) continue;
    buckets.set(k, (buckets.get(k) as number) + (amount ? Number(amount(row) ?? 0) : 1));
  }

  const series = keys.map((k) => buckets.get(k) as number);
  if (series.every((v) => v === 0)) return EMPTY;
  return { trend: worthPlotting(series) ? series : null, delta: delta(series) };
}
