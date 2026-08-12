/**
 * Do the columns a migration names actually exist?
 *
 *   node scripts/check-sql-columns.mjs supabase/migrations/0083_fix_stitches_chain.sql
 *
 * WHY THIS EXISTS
 * ---------------
 * Three migrations in a row failed on a column name this session:
 *   grns.po_id            (the real one is purchase_order_id)
 *   jc.assigned_machine_id (it is on orders, not job_cards)
 *   d.deduction_amount    (invented outright; the real one is deduction)
 *
 * Every one was avoidable by asking the database instead of trusting the file or
 * my memory of it. A `language sql` body fails loudly at CREATE, but a plpgsql
 * body does not — it plans per statement at RUN time, so a bad column there ships
 * silently and breaks the first time a user hits that path. That asymmetry is
 * exactly why this needs to be mechanical rather than a habit.
 *
 * It resolves aliases from `from public.X a` / `join public.X a` and then asks
 * PostgREST for each alias.column with `limit=0`, which returns 200 when the
 * column exists and 400 when it does not. Read-only.
 *
 * Heuristic, and honest about it: it cannot see columns introduced by the same
 * migration, CTE names, or out-params of a `returns table`. Those show as
 * UNKNOWN rather than BAD, and are listed for a human to glance at.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-sql-columns.mjs <path-to.sql>');
  process.exit(2);
}
const sql = readFileSync(file, 'utf8');

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL, KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Strip comments so documented mistakes aren't reported as real ones.
const code = sql
  .split('\n')
  .map((l) => (l.trim().startsWith('--') ? '' : l.replace(/--.*$/, '')))
  .join('\n');

/**
 * alias -> the SET of tables that alias binds to anywhere in the file.
 *
 * A Set, not one table, because a letter is reused across statements: `s` is
 * `suppliers` in one query and `sheets` in another; `r` is `repeats` here and a
 * set-returning function's row there. A last-wins map reported ten columns as
 * missing that were all fine — and a checker that cries wolf gets ignored, which
 * is worse than not having one.
 *
 * A column passes if it exists in ANY candidate table. That under-reports rather
 * than over-reports, which is the right way round for a heuristic: it will never
 * block on something that is actually correct.
 */
const alias = new Map();
const RESERVED = ['on','where','set','using','group','order','left','join','lateral','as','select','and','or'];
const bind = (a, table) => {
  const k = a.toLowerCase();
  if (RESERVED.includes(k)) return;
  if (!alias.has(k)) alias.set(k, new Set());
  alias.get(k).add(table);
};
for (const m of code.matchAll(/\b(?:from|join)\s+public\.([a-z_]+)\s+(?:as\s+)?([a-z][a-z0-9_]*)/gi)) {
  bind(m[2], m[1]);
}
for (const m of code.matchAll(/\b(?:from|join|into|update)\s+public\.([a-z_]+)/gi)) {
  bind(m[1], m[1]);
}

// Aliases bound to a set-returning FUNCTION are not relations — their columns are
// out-params and cannot be looked up on a table.
const fnAlias = new Set();
for (const m of code.matchAll(/\bpublic\.[a-z_]+\s*\([^()]*\)\s+(?:as\s+)?([a-z][a-z0-9_]*)/gi)) {
  fnAlias.add(m[1].toLowerCase());
}

const added = new Set(
  [...code.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]+)/gi)].map((m) => m[1])
);

const pairs = new Map();
for (const m of code.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z_]+)\b/g)) {
  const [, a, col] = m;
  const k = a.toLowerCase();
  if (k === 'public' || !alias.has(k) || fnAlias.has(k)) continue;
  if (added.has(col)) continue;
  for (const table of alias.get(k)) {
    pairs.set(`${table}.${col}`, { table, col, candidates: alias.get(k) });
  }
}

const login = async () => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@alpha.test', password: 'Password123!' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('login failed');
  return j.access_token;
};

const tok = await login();
const H = { apikey: KEY, Authorization: `Bearer ${tok}` };

console.log(`\n  Column check — ${file}`);
console.log(`  ${pairs.size} distinct table.column reference(s)\n`);

let bad = 0, unknown = 0, good = 0;
const byTable = new Map();
for (const { table, col } of pairs.values()) {
  if (!byTable.has(table)) byTable.set(table, []);
  byTable.get(table).push(col);
}

for (const [table, cols] of [...byTable.entries()].sort()) {
  const r = await fetch(`${URL_}/rest/v1/${table}?select=${cols.join(',')}&limit=0`, { headers: H });
  if (r.status === 200) {
    good += cols.length;
    console.log(`  ok    ${table}  (${cols.length})`);
    continue;
  }
  const body = await r.text();
  if (/does not exist/i.test(body) && /relation|table/i.test(body)) {
    unknown += cols.length;
    console.log(`  ?     ${table}  — table not in this database yet (created by this migration?)`);
    continue;
  }
  // One bad column fails the whole select, so re-check individually to name it.
  for (const c of cols) {
    const one = await fetch(`${URL_}/rest/v1/${table}?select=${c}&limit=0`, { headers: H });
    if (one.status === 200) { good++; continue; }
    const t = await one.text();
    if (/column .* does not exist/i.test(t)) {
      // BAD only if NO table this alias could mean has the column.
      const cands = pairs.get(`${table}.${c}`)?.candidates ?? new Set([table]);
      let elsewhere = false;
      for (const alt of cands) {
        if (alt === table) continue;
        const o = await fetch(`${URL_}/rest/v1/${alt}?select=${c}&limit=0`, { headers: H });
        if (o.status === 200) { elsewhere = true; break; }
      }
      if (elsewhere) { good++; continue; }
      bad++;
      const hint = /Perhaps you meant[^"]*/i.exec(t);
      console.log(`  BAD   ${table}.${c}${hint ? '   ' + hint[0].trim() : ''}`);
    } else {
      unknown++;
      console.log(`  ?     ${table}.${c}  (${one.status})`);
    }
  }
}

console.log(`\n  ${good} resolved, ${bad} BAD, ${unknown} unknown\n`);
process.exit(bad ? 1 : 0);
