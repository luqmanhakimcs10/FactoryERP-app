/**
 * Front-of-dashboard task banners (migrations 0065/0066).
 *
 * Checks the three links in the chain the feature promises:
 *   banner  -> a real count of a real queue
 *   list    -> exactly those items, same predicate, no drift
 *   item    -> enough identifiers to open the existing working screen
 *
 * Alpha factory. Run: node scripts/verify-task-banners.mjs
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL, KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

const login = async (e) => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Password123!' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed: ${e}`);
  return j.access_token;
};
const rpc = async (fn, tok, args) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/**
 * Mirrors `src/navigation/taskQueues.ts`. Kept in step by the assertion below
 * that every queue a role is offered has an entry here — if a new queue is
 * added to SQL without a route, this test fails rather than the app silently
 * rendering a banner that goes nowhere.
 */
const ROUTES = {
  awaiting_job_card: (i) => (i.status === 'awaiting_job_card' ? ['JobCardBuilder', i.order_id] : ['JobCard', i.order_id]),
  accept_inventory:  () => ['OrdersBox', 'tab'],
  fm_collect:        (i) => ['StageTracking', i.order_id],
  fm_handover:       (i) => ['StageTracking', i.order_id],
  fm_final_qa:       (i) => ['FinalQaDetail', i.order_id],
  material_requests: (i) => ['IssueDetail', i.secondary_id],
  grn_pending:       (i) => ['GrnDetail', i.secondary_id],
  qa_inspection:     (i) => (i.status === 'awaiting_cloth_inspection' ? ['ClothInspection', i.order_id] : ['OrderQa', i.order_id]),
  qa_stage:          (i) => ['StageTracking', i.order_id],
  qa_final:          () => ['FinalPassQueue', 'n/a'],
  dp_collect:        () => ['(inline)', 'n/a'],
  dp_send:           () => ['(inline)', 'n/a'],
  dp_pickup:         () => ['(inline)', 'n/a'],
  dp_handback:       () => ['(inline)', 'n/a'],
  partner_active:    () => ['(inline)', 'n/a'],
  ot_returns:        () => ['Returns', 'n/a'],
  acct_receivables:  (i) => ['InvoiceDetail', i.secondary_id],
  acct_payables:     () => ['Expenses', 'n/a'],
  owner_approvals:   (i) => ['ApprovalDetail', i.secondary_id],
  po_draft:          (i) => ['PoDetail', i.secondary_id],
};

const ROLES = [
  ['Floor Manager',     'floor@alpha.test',       'floor_manager'],
  ['Initial QA',        'qa@alpha.test',          'qa'],
  ['Order Taker',       'order@alpha.test',       'order_taker'],
  ['Store Manager',     'store@alpha.test',       'store_manager'],
  ['Delivery',          'delivery@alpha.test',    'delivery'],
  ['Finishing Partner', 'partner@alpha.test',     'finishing_partner'],
  ['Accountant',        'accountant@alpha.test',  'accountant'],
  ['Owner',             'owner@alpha.test',       'company_admin'],
  ['Procurement',       'procurement@alpha.test', 'procurement'],
  ['Worker',            'worker@alpha.test',      'worker'],
];

console.log('\n============ TASK BANNERS (0065/0066) ============');
console.log('Factory: Alpha Embroidery Works\n');

const tokens = {};
for (const [, email] of ROLES) tokens[email] = await login(email);

// ---------------------------------------------------------------------------
console.log('=== 1. Every role: banners are real counts of real queues ===');
for (const [name, email] of ROLES) {
  const tok = tokens[email];
  const s = await rpc('my_queue_summary', tok, {});
  if (s.status !== 200) { no(`${name}: summary -> HTTP ${s.status}`); continue; }

  const banners = (s.body ?? []).filter((r) => r.own_task && Number(r.count) > 0);
  if (banners.length === 0) {
    ok(`${name.padEnd(18)} no pending work -> no banners (dashboard stays clean)`);
    continue;
  }

  console.log(`  ..    ${name}: ${banners.length} banner(s)`);
  for (const b of banners) {
    const items = await rpc('my_queue_items', tok, { p_queue_key: b.queue_key });
    const rows = items.body ?? [];

    chk(rows.length === Number(b.count),
      `  "${b.banner_title}" -> list has ${rows.length} (banner says ${b.count})`);

    // Plain language, not state-machine vocabulary.
    chk(!/_/.test(b.banner_title) && /\b(need|ready|waiting|to )\b/i.test(b.banner_title),
      `  wording is plain: "${b.banner_title}"`);

    // Every offered queue must have a destination.
    const route = ROUTES[b.queue_key];
    chk(!!route, `  queue "${b.queue_key}" has a route mapping`);

    if (route && rows.length > 0) {
      const [screen, param] = route(rows[0]);
      chk(!!param, `  first item ${rows[0].code} carries what ${screen} needs`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. The owner is not buried (own_task) ===');
{
  const s = await rpc('my_queue_summary', tokens['owner@alpha.test'], {});
  const all = (s.body ?? []).filter((r) => Number(r.count) > 0);
  const own = all.filter((r) => r.own_task);
  chk(all.length > own.length,
    `owner sees ${all.length} queues on the bell but only ${own.length} banner(s)`);
  chk(own.every((r) => r.queue_key === 'owner_approvals'),
    `the owner's banner is their approvals, not everyone else's work`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. A queue key is not a capability ===');
{
  // QA asking for the floor manager's queue gets nothing, not an error and not
  // another role's rows.
  const r = await rpc('my_queue_items', tokens['qa@alpha.test'], { p_queue_key: 'awaiting_job_card' });
  chk(r.status === 200 && (r.body ?? []).length === 0,
    `QA requesting the FM queue -> HTTP ${r.status}, ${(r.body ?? []).length} rows`);

  const b = await rpc('my_queue_items', await login('floor@beta.test'), { p_queue_key: 'awaiting_job_card' });
  const alpha = await rpc('my_queue_items', tokens['floor@alpha.test'], { p_queue_key: 'awaiting_job_card' });
  const alphaIds = new Set((alpha.body ?? []).map((x) => x.item_id));
  const leaked = (b.body ?? []).filter((x) => alphaIds.has(x.item_id));
  chk(leaked.length === 0,
    `Beta's floor manager sees ${(b.body ?? []).length} of its own, 0 of Alpha's`);

  const bogus = await rpc('my_queue_items', tokens['floor@alpha.test'], { p_queue_key: 'not_a_queue' });
  chk(bogus.status === 200 && (bogus.body ?? []).length === 0,
    'an unknown queue key returns empty rather than erroring');
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Counts agree with the screens they point at ===');
{
  const fm = tokens['floor@alpha.test'];
  const s = (await rpc('my_queue_summary', fm, {})).body ?? [];
  const jc = s.find((r) => r.queue_key === 'awaiting_job_card');
  if (jc) {
    // The Orders box's own "Awaiting job card" tab uses exactly this filter.
    const direct = await fetch(
      `${URL_}/rest/v1/orders?select=id&status=in.(awaiting_job_card,job_card_shared)`,
      { headers: { apikey: KEY, Authorization: `Bearer ${fm}` } });
    const rows = await direct.json();
    chk(rows.length === Number(jc.count),
      `banner (${jc.count}) matches the Orders box tab's own query (${rows.length})`);
  }

  const qa = tokens['qa@alpha.test'];
  const qs = (await rpc('my_queue_summary', qa, {})).body ?? [];
  const insp = qs.find((r) => r.queue_key === 'qa_inspection');
  if (insp) {
    const direct = await fetch(
      `${URL_}/rest/v1/orders?select=id&status=in.(awaiting_cloth_inspection,awaiting_coding)`,
      { headers: { apikey: KEY, Authorization: `Bearer ${qa}` } });
    const rows = await direct.json();
    chk(rows.length === Number(insp.count),
      `QA banner (${insp.count}) matches the inspection queue's own query (${rows.length})`);
  }
}

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
