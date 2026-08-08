/**
 * Banner coverage audit.
 *
 * For every role, puts the counts its SCREENS already show next to the banners
 * its DASHBOARD renders, and flags any on-screen count that has no banner.
 *
 * This exists because the first pass at banners was built from an example list
 * rather than from the app, and missed real queues. A count a screen is already
 * willing to display is, by definition, a queue the app considers worth
 * counting — so it is the right thing to audit against.
 *
 * Read-only. Alpha factory. Run: node scripts/audit-banner-coverage.mjs
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL, KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const login = async (e) => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Password123!' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed: ${e}`);
  return j.access_token;
};
const H = (tok) => ({ apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });
const rpc = async (fn, tok, args) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: H(tok), body: JSON.stringify(args ?? {}),
  });
  return r.ok ? await r.json().catch(() => null) : { __err: r.status };
};
const rest = async (path, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H(tok) });
  return r.ok ? await r.json() : { __err: r.status };
};
const n = (v) => (Array.isArray(v) ? v.length : 0);

/**
 * Each entry is one count the role's screens ALREADY display, with where it is
 * shown and which banner queue key is meant to cover it. `queue: null` means
 * "no banner covers this" — the thing this audit is looking for.
 */
const AUDIT = {
  'Floor Manager': {
    email: 'floor@alpha.test',
    counts: async (t) => [
      ['Orders box tab "Awaiting job card"', n(await rest('orders?select=id&status=in.(awaiting_job_card,job_card_shared)', t)), 'awaiting_job_card'],
      ['Orders box tab "Accept inventory"', n(await rpc('fm_pending_material_acceptance', t)), 'accept_inventory'],
      ['Dashboard card "Shift close"', n(await rpc('fm_shift_close_queue', t)), 'fm_shift_close'],
      ['Dashboard card "Leave"', n(await rest('leaves?select=id&status=eq.pending', t)), 'fm_leave'],
      ['Dashboard card "Damages"', n(await rest('damage_records?select=id', t)), '(register, not a queue)'],
      ['Dashboard card "Orders" (total)', n(await rest('orders?select=id', t)), '(registry total)'],
      // Added by the Store Manager restructure and initially missed — the whole
      // reason this audit is re-run rather than trusted.
      ['Orders box tab "Handover"', n(await rpc('fm_handover_queue', t)), 'fm_store_handover'],
      ['Auto "material ready" notices', n(await rest("material_requests?select=id&origin=eq.auto_stock_ready&directed_to=eq.floor_manager&status=eq.pending", t)), 'fm_material_ready'],
    ],
  },
  'Initial QA': {
    email: 'qa@alpha.test',
    counts: async (t) => [
      ['Card "Awaiting order inspection"', n(await rest('orders?select=id&status=in.(awaiting_cloth_inspection,awaiting_coding)', t)), 'qa_inspection'],
      // Orders IN PRODUCTION, which is not the same question as "needs QA".
      // The actionable subset is qa_stage (repeats sitting at stage_qa) and it
      // has its own line below. Pairing this card with qa_stage made the audit
      // report a permanent false gap: a banner reading "N pieces need stage QA"
      // off this number would send QA to an empty screen.
      ['Card "Repeats & stage tracking"', n(await rest('orders?select=id&status=in.(in_production,in_finishing)', t)), '(registry total)'],
      ['Repeats actually at stage QA', n(await rest('repeats?select=id&current_status=eq.stage_qa', t)), 'qa_stage'],
      ['Card "Final pass"', n(await rpc('qa_final_queue', t)), 'qa_final'],
    ],
  },
  'Store Manager': {
    email: 'store@alpha.test',
    counts: async (t) => [
      ['Card "PO" (deliveries to confirm)', n(await rest('grns?select=id&status=eq.pending', t)), 'grn_pending'],
      ['Stat "Job cards to issue"', n(await rpc('material_issue_queue', t)), 'material_requests'],
      ['Audit tab — today not done', (await rpc('audit_today_state', t))?.[0]?.done ? 0 : 1, 'sm_audit_today'],
      // The PO and Requests tab counts are registry views of other people's
      // work: the store manager's own actionable subsets are grn_pending and
      // material_requests, both covered above.
      ['Home tab "PO" (open)', n(await rpc('sm_po_list', t)), '(registry total)'],
      ['Home tab "Requests" (all)', n(await rpc('material_request_history', t)), '(registry total)'],
    ],
  },
  'Order Taker': {
    email: 'order@alpha.test',
    counts: async (t) => [
      ['Card "Returns" (active bucket)', n((await rpc('ot_return_repeats', t))?.filter?.((r) => r.bucket === 'active')), 'ot_returns'],
    ],
  },
  Delivery: {
    email: 'delivery@alpha.test',
    counts: async (t) => [
      ['Header "N items to move"', n(await rpc('dp_orders_queue', t)), 'dp_collect+dp_send+dp_pickup+dp_handback'],
      ['Section "Ready for final delivery"', n(await rpc('dp_final_delivery_queue', t)), 'dp_final_delivery'],
    ],
  },
  'Finishing Partner': {
    email: 'partner@alpha.test',
    counts: async (t) => [
      ['Tab "Active work"', n(await rpc('partner_active_work', t)), 'partner_active'],
    ],
  },
  Accountant: {
    email: 'accountant@alpha.test',
    counts: async (t) => [
      ['Card "Invoices" (total)', n(await rest('invoices?select=id&status=neq.cancelled', t)), '(registry total)'],
      ['Invoices — unpaid', n(await rest('invoices?select=id&status=eq.pending', t)), 'acct_receivables'],
      ['Payables — approved bills', n(await rest('expenses?select=id&status=eq.approved', t)), 'acct_payables'],
    ],
  },
  Owner: {
    email: 'owner@alpha.test',
    counts: async (t) => [
      ['Expenses awaiting approval', n(await rest('expenses?select=id&status=eq.pending', t)), 'owner_approvals'],
    ],
  },
  Procurement: {
    email: 'procurement@alpha.test',
    counts: async (t) => [
      ['PO filter "To action" — pre-execution', n(await rest('purchase_orders?select=id&status=in.(auto_generated,draft)', t)), 'po_draft'],
      ['PO filter "To action" — executed/paid', n(await rest('purchase_orders?select=id&status=in.(executed,paid)', t)), 'po_in_flight'],
    ],
  },
  Worker: {
    email: 'worker@alpha.test',
    counts: async (t) => [],
  },
};

console.log('\n=========== BANNER COVERAGE AUDIT — Alpha ===========\n');
const gaps = [];

for (const [role, cfg] of Object.entries(AUDIT)) {
  const tok = await login(cfg.email);
  const summary = await rpc('my_queue_summary', tok, {});
  const banners = (Array.isArray(summary) ? summary : [])
    .filter((r) => r.own_task && Number(r.count) > 0);
  const haveKeys = new Set(banners.map((b) => b.queue_key));

  console.log(`--- ${role} ---`);
  console.log(`  banners now: ${banners.length ? banners.map((b) => `${b.queue_key}(${b.count})`).join(', ') : 'none'}`);

  for (const [where, count, queue] of await cfg.counts(tok)) {
    const informational = queue.startsWith('(');
    const covered = informational
      || queue.split('+').some((k) => haveKeys.has(k))
      || count === 0;
    const mark = informational ? 'INFO' : covered ? ' ok ' : 'GAP!';
    console.log(`  [${mark}] ${String(count).padStart(4)}  ${where}  -> ${queue}`);
    if (mark === 'GAP!') gaps.push(`${role}: ${where} = ${count}, no banner (${queue})`);
  }
  console.log('');
}

console.log('=========== GAPS ===========');
if (gaps.length === 0) console.log('  none — every non-zero on-screen count has a banner');
else gaps.forEach((g) => console.log('  ' + g));
console.log('');
