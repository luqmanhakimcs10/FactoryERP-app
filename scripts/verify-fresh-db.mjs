/**
 * Is the database actually back at the seed baseline?
 *
 *   npm run verify:fresh
 *
 * Run this AFTER pasting supabase/maintenance/reset_to_seed_baseline.sql into
 * the Supabase SQL editor. The SQL prints its own counts, but those are read as
 * the table owner, which is not the surface the app has. This script signs in
 * with the anon key as all 21 seeded accounts and asks the same questions
 * through RLS, so "the reset worked" means "the app can be driven from here".
 *
 * Read-only. It creates nothing, so it can be re-run at any point and the
 * database it reports on is the one you then start using.
 *
 * The three checks past "is it empty" are the ones that actually bite:
 *   - every seeded login still authenticates AND my_factory_active() is true.
 *     A factory left account_status='inactive' signs its users straight back
 *     out after login, which looks like broken auth rather than a disabled
 *     tenant.
 *   - opening_stock_completed_at is null. That gate is one-time; with thread
 *     stock wiped and the flag still set, the store manager has an empty ledger
 *     and no screen that will let them fill it.
 *   - exactly two factories, 21 profiles, no stragglers from app-created
 *     employees or factories.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const BASE = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE || !KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(2);
}

const PASSWORD = 'Password123!';
const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';

const WHO = ['owner', 'accountant', 'floor', 'store', 'order', 'qa', 'procurement', 'delivery', 'worker', 'partner'];
const SEEDED = ['super@erp.test', ...WHO.flatMap((w) => [`${w}@alpha.test`, `${w}@beta.test`])];

/** Must be empty. Ordered as the app meets them, not alphabetically. */
const EMPTY = [
  'orders', 'sheets', 'repeats', 'order_stages', 'repeat_stage_history',
  'job_cards', 'job_card_lines', 'damage_records', 'sla_alerts',
  'material_issues', 'material_issue_items', 'purchase_orders', 'po_items',
  'grns', 'grn_items', 'stock_movements', 'stock_audits', 'stock_audit_items',
  'inventory_items', 'material_requests', 'machine_mounted_items', 'fm_handovers',
  'shifts', 'downtime_reports', 'worker_ledger',
  'partner_ledger', 'leaves', 'loans', 'employee_compensation',
  'bonus_slab_proposals', 'invoices', 'payments', 'expenses',
  'user_permissions', 'vendors', 'suppliers', 'machines', 'finishing_partners',
];

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);
const head = (m) => console.log('\n== ' + m + ' ' + '='.repeat(Math.max(0, 66 - m.length)));

async function login(email) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json().catch(() => null);
  return j?.access_token ? { token: j.access_token, userId: j.user?.id } : null;
}

const auth = (t) => ({ apikey: KEY, Authorization: `Bearer ${t}` });

/** Row count through RLS, or null if the table refuses the read. */
async function count(token, table) {
  const r = await fetch(`${BASE}/rest/v1/${table}?select=*&limit=1`, {
    headers: { ...auth(token), Prefer: 'count=exact' },
  });
  if (!r.ok) return { error: `${r.status} ${(await r.text()).slice(0, 100)}` };
  const n = Number((r.headers.get('content-range') ?? '/?').split('/')[1]);
  return { n: Number.isFinite(n) ? n : null };
}

async function rpc(token, fn, args = {}) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
head('Every seeded login works, and its factory is switched on');
// ---------------------------------------------------------------------------
const tokens = {};
for (const email of SEEDED) {
  const s = await login(email);
  if (!s) { no(`${email} — cannot sign in`); continue; }
  tokens[email] = s.token;
  if (email === 'super@erp.test') { ok(`${email} — signs in (super admin, no factory)`); continue; }
  const active = await rpc(s.token, 'my_factory_active');
  chk(active.body === true, `${email} — signs in and my_factory_active() is true`);
  if (active.body !== true) info('the app signs this user straight back out; factory account_status is not active');
}

// ---------------------------------------------------------------------------
head('Nothing left behind, seen from inside each tenant');
// ---------------------------------------------------------------------------
for (const [label, email] of [['Alpha', 'owner@alpha.test'], ['Beta', 'owner@beta.test']]) {
  const token = tokens[email];
  if (!token) { no(`${label} — no session, cannot check`); continue; }
  const dirty = [];
  const errs = [];
  for (const t of EMPTY) {
    const c = await count(token, t);
    if (c.error) errs.push(`${t}: ${c.error}`);
    else if (c.n !== 0) dirty.push(`${t}=${c.n}`);
  }
  chk(dirty.length === 0, `${label} — all ${EMPTY.length} operational and master tables are empty`);
  if (dirty.length) info('still populated: ' + dirty.join(', '));
  if (errs.length) { no(`${label} — some tables could not be read`); errs.forEach((e) => info(e)); }
}

// ---------------------------------------------------------------------------
head('The baseline itself survived');
// ---------------------------------------------------------------------------
{
  const token = tokens['super@erp.test'];
  if (!token) {
    no('no super admin session, cannot check the baseline');
  } else {
    const f = await fetch(`${BASE}/rest/v1/factories?select=id,name,code_prefix,account_status,opening_stock_completed_at&order=name`, { headers: auth(token) });
    const rows = f.ok ? await f.json() : [];
    chk(rows.length === 2, `exactly 2 factories remain (found ${rows.length})`);
    const ids = rows.map((r) => r.id);
    chk(ids.includes(ALPHA) && ids.includes(BETA), 'the seeded Alpha and Beta are both still there');
    for (const r of rows) {
      info(`${r.name} [${r.code_prefix}] account=${r.account_status} opening_stock=${r.opening_stock_completed_at ?? 'not yet entered'}`);
    }
    chk(rows.every((r) => r.account_status === 'active'), 'both factories are active');
    chk(rows.every((r) => r.opening_stock_completed_at === null),
      'opening stock has not been entered — the store manager can still enter it');

    const p = await count(token, 'profiles');
    chk(p.n === SEEDED.length, `${SEEDED.length} profiles remain (found ${p.n}) — no app-created employees left`);

    // 11 from 0002, plus 'manager' and 'labour' which 0030 adds for add_employee.
    const roles = await count(token, 'roles');
    chk(roles.n === 13, `the 13 roles are intact (found ${roles.n})`);
  }
}

// ---------------------------------------------------------------------------
head('Module gating is still the thing that makes two tenants worth having');
// ---------------------------------------------------------------------------
for (const [label, email, expected] of [
  ['Alpha', 'owner@alpha.test', 4],
  ['Beta', 'owner@beta.test', 2],
]) {
  const token = tokens[email];
  if (!token) { no(`${label} — no session, cannot check modules`); continue; }
  const r = await fetch(`${BASE}/rest/v1/factory_modules?select=enabled&enabled=is.true`, {
    headers: { ...auth(token), Prefer: 'count=exact' },
  });
  const n = r.ok ? Number((r.headers.get('content-range') ?? '/?').split('/')[1]) : NaN;
  chk(n === expected, `${label} has ${expected} modules enabled (found ${n})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nThe database is NOT at a clean baseline. Re-read the failures above before');
  console.log('starting to use the app — a half-reset database wastes the walkthrough.');
}
process.exit(fail ? 1 : 0);
