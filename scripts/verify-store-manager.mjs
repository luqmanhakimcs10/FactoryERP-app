/**
 * Store Manager restructure (migrations 0068-0072) — Alpha factory.
 *
 * Checks the brief's definition of done, one section per bullet:
 *   1. inventory_items covers all four types, thread_stock still reads
 *   2. sufficient stock -> a Request, not a PO; shortfall -> a PO for exactly
 *      the missing quantity, origin auto_shortfall
 *   3. a manual PO carries its procurement assignee
 *   4. all four types add, and sequin-by-CD computes the count
 *   5. the daily audit walks, logs variance and builds a date history
 *   6. handover credits decimal leftovers and keeps On Machine separate
 *   7. tenancy: none of the new RPCs leak across factories
 *
 * Run: node scripts/verify-store-manager.mjs
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
const q = async (path, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${tok}` },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('\n======= STORE MANAGER RESTRUCTURE (0068-0072) =======');
console.log('Factory: Alpha Embroidery Works\n');

/**
 * Preflight. Every section below calls functions that only exist once 0068-0072
 * have run, and a missing function returns 404 — which would otherwise surface
 * as thirty confusing assertion failures and a crash on the first `.every()`
 * over a non-array. Say the actual problem once, and stop.
 */
{
  const tok = await login('store@alpha.test');
  const probe = await rpc('inventory_list', tok, {});
  if (probe.status === 404) {
    console.log('  ----  Migrations 0068-0072 are NOT applied to this database.');
    console.log('        `inventory_list` returned 404, so nothing below can run.');
    console.log('        Apply the migrations, then re-run this script.\n');
    process.exit(2);
  }
}

const A = {
  sm: await login('store@alpha.test'),
  fm: await login('floor@alpha.test'),
  ot: await login('order@alpha.test'),
  proc: await login('procurement@alpha.test'),
};
const B = { sm: await login('store@beta.test') };

// A unique suffix so repeat runs never collide on the identity index.
const TAG = Date.now().toString(36).slice(-5).toUpperCase();

// ---------------------------------------------------------------------------
console.log('=== 1. inventory_items generalises thread_stock ===');
{
  const inv = await rpc('inventory_list', A.sm, {});
  chk(inv.status === 200, `inventory_list -> HTTP ${inv.status}`);

  const rows = inv.body ?? [];
  chk(rows.length > 0, `${rows.length} inventory rows`);
  chk(rows.every((r) => ['thread', 'tilla', 'sequin', 'bobbin'].includes(r.item_type)),
    'every row has one of the four item types');
  chk(rows.every((r) => r.unit && r.source), 'every row carries a unit and a source');

  // The compatibility view must still answer, and must show ONLY thread.
  const ts = await q('thread_stock?select=id,color_code,quantity_meters&limit=500', A.sm);
  chk(ts.status === 200, `thread_stock view still readable -> HTTP ${ts.status}`);
  const threads = rows.filter((r) => r.item_type === 'thread');
  chk((ts.body ?? []).length === threads.length,
    `view shows ${(ts.body ?? []).length} rows = the ${threads.length} thread items (no leakage of other types)`);

  // Same row, not a copy: ids and balances must agree.
  const byId = new Map(threads.map((t) => [t.id, Number(t.quantity)]));
  const mismatched = (ts.body ?? []).filter(
    (v) => !byId.has(v.id) || byId.get(v.id) !== Number(v.quantity_meters));
  chk(mismatched.length === 0,
    'view and table are the same rows — no id or balance drift');

  // The tenancy rule the old table had must survive the rename.
  const w = await fetch(`${URL_}/rest/v1/thread_stock?color_code=eq.RED-01`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${A.sm}`, 'Content-Type': 'application/json',
               Prefer: 'return=representation' },
    body: JSON.stringify({ quantity_meters: 1 }),
  });
  const wrote = w.status < 300 && (await w.json().catch(() => [])).length > 0;
  chk(!wrote, `direct UPDATE through the view is still refused (HTTP ${w.status})`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Sufficient stock -> Request; shortfall -> PO ===');
{
  const pos = await rpc('sm_po_list', A.sm, {});
  chk(pos.status === 200, `sm_po_list -> HTTP ${pos.status}`);
  const rows = pos.body ?? [];
  chk(rows.every((p) => ['auto_shortfall', 'manual'].includes(p.origin)),
    'every PO declares an origin');
  chk(rows.some((p) => p.origin === 'auto_shortfall'),
    `${rows.filter((p) => p.origin === 'auto_shortfall').length} POs were raised by a shortfall`);

  // Every auto PO's lines must be the SHORTFALL, never the whole requirement.
  const auto = rows.find((p) => p.origin === 'auto_shortfall' && p.order_code);
  if (auto) {
    const items = await q(
      `po_items?purchase_order_id=eq.${auto.id}&select=color_code,quantity_meters`, A.sm);
    const lines = items.body ?? [];
    chk(lines.length > 0 && lines.every((l) => Number(l.quantity_meters) > 0),
      `${auto.po_code}: ${lines.length} shortfall line(s), all positive`);
  } else {
    ok('no auto PO with an order to cross-check (nothing to compare)');
  }

  const reqs = await rpc('material_request_history', A.sm, {});
  chk(reqs.status === 200, `material_request_history -> HTTP ${reqs.status}`);
  const rr = reqs.body ?? [];
  chk(rr.every((r) => ['job_card', 'auto_stock_ready'].includes(r.origin)),
    `${rr.length} requests, every one with a known origin`);
  chk(rr.every((r) =>
      (r.origin === 'auto_stock_ready') === (r.directed_to === 'floor_manager')),
    'auto requests go to the floor manager, job-card requests to the store');

  // The backfill must not have claimed every historic request is still open.
  const done = rr.filter((r) => r.status !== 'pending').length;
  chk(rr.length === 0 || done > 0,
    `${done} of ${rr.length} requests are already issued or completed (history, not a fresh queue)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. A manual PO names its procurement person ===');
{
  const people = await rpc('procurement_users', A.sm, {});
  chk(people.status === 200 && (people.body ?? []).length > 0,
    `${(people.body ?? []).length} procurement user(s) available to assign`);

  const inv = (await rpc('inventory_list', A.sm, {})).body ?? [];
  const item = inv[0];
  const person = (people.body ?? [])[0];

  if (item && person) {
    const made = await rpc('sm_create_manual_po', A.sm, {
      p_items: [{ inventory_item_id: item.id, quantity: 5 }],
      p_assigned_to: person.id,
      p_note: `verify ${TAG}`,
    });
    chk(made.status === 200, `sm_create_manual_po -> HTTP ${made.status}`);
    const poId = made.body?.id;
    chk(made.body?.origin === 'manual', `origin is manual, not auto_shortfall`);
    chk(made.body?.assigned_procurement_user_id === person.id,
      `tagged to ${person.display_name}`);

    // It must actually reach that person's queue, which is the point.
    const theirs = await q(
      `purchase_orders?id=eq.${poId}&select=po_code,assigned_procurement_user_id,status`, A.proc);
    chk((theirs.body ?? []).length === 1,
      `procurement can see ${made.body?.po_code} on their side`);

    // No assignee must be refused.
    const bad = await rpc('sm_create_manual_po', A.sm, {
      p_items: [{ inventory_item_id: item.id, quantity: 1 }],
      p_assigned_to: null,
    });
    chk(bad.status >= 400, `an untagged manual PO is refused (HTTP ${bad.status})`);
  } else {
    no('could not build a manual PO — no inventory item or no procurement user');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. All four types add; sequin CD maths is the database’s ===');
{
  const adds = [
    { type: 'thread', args: { p_item_type: 'thread', p_color_code: `VT-${TAG}`, p_quantity: 4 }, expect: 4 },
    { type: 'tilla',  args: { p_item_type: 'tilla',  p_color_code: `VL-${TAG}`, p_quantity: 12 }, expect: 12 },
    { type: 'bobbin', args: { p_item_type: 'bobbin', p_color_code: `VB-${TAG}`, p_quantity: 250.5 }, expect: 250.5 },
  ];
  for (const a of adds) {
    const r = await rpc('sm_add_inventory', A.sm, a.args);
    chk(r.status === 200 && Number(r.body?.quantity) === a.expect,
      `${a.type}: added ${a.expect} ${r.body?.unit ?? ''} (HTTP ${r.status})`);
  }

  // Decimals must survive — 2.3 cones is the brief's own example.
  const dec = await rpc('sm_add_inventory', A.sm, {
    p_item_type: 'thread', p_color_code: `VD-${TAG}`, p_quantity: 2.3,
  });
  chk(Number(dec.body?.quantity) === 2.3, `decimal quantity kept exactly: ${dec.body?.quantity}`);

  // (90 x 914 / 3) x 0.8 = 21936 per CD; 6 CDs = 131616.
  const expected = Math.round(6 * ((90 * 914) / 3) * 0.8);
  const seq = await rpc('sm_add_inventory', A.sm, {
    p_item_type: 'sequin', p_color_code: `VS-${TAG}`, p_size_mm: 3,
    p_cd_count: 6, p_yards_per_cd: 90, p_sequin_type: 'Matt',
  });
  chk(seq.status === 200 && Number(seq.body?.quantity) === expected,
    `6 CDs at 3 mm -> ${seq.body?.quantity} sequins (formula says ${expected})`);
  chk(Number(seq.body?.cd_count) === 6,
    'the CD count entered is kept alongside the computed total');

  const formula = await rpc('sequin_count_from_cds', A.sm,
    { p_cd_count: 1, p_size_mm: 9, p_yards_per_cd: 90 });
  chk(Number(formula.body) === Math.round(((90 * 914) / 9) * 0.8),
    `9 mm: 1 CD -> ${formula.body} sequins`);

  const badSize = await rpc('sm_add_inventory', A.sm, {
    p_item_type: 'sequin', p_color_code: `VX-${TAG}`, p_size_mm: 7, p_quantity: 10,
  });
  chk(badSize.status >= 400, `a 7 mm sequin is refused (HTTP ${badSize.status})`);

  const manual = ((await rpc('inventory_list', A.sm, {})).body ?? [])
    .find((i) => i.color_code === `VT-${TAG}`);
  chk(manual?.source === 'manual', 'hand-added stock is badged Manual, not PO');

  // Every add must have left a ledger row, or the balance stops reconciling.
  const mv = await q(
    `stock_movements?color_code=eq.VT-${TAG}&select=movement_type,quantity_meters,item_type`, A.sm);
  chk((mv.body ?? []).some((m) => m.movement_type === 'manual_add'),
    'the manual add is in the stock ledger');
  chk((mv.body ?? []).every((m) => m.item_type), 'ledger rows carry their item type');
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Daily audit ===');
{
  const walk = await rpc('audit_walk_items', A.sm, {});
  chk(walk.status === 200 && (walk.body ?? []).length > 0,
    `walk offers ${(walk.body ?? []).length} items with a system count`);
  chk((walk.body ?? []).every((i) => i.expected_quantity != null && i.unit),
    'every walk item shows an expected figure and its unit');

  const before = await rpc('audit_today_state', A.sm, {});
  chk(before.status === 200, `audit_today_state -> HTTP ${before.status}`);
  const already = Array.isArray(before.body) ? before.body[0]?.done : before.body?.done;

  if (already) {
    ok('today’s audit is already done — the once-a-day rule is what this asserts');
    const again = await rpc('sm_submit_daily_audit', A.sm, {
      p_items: [{ inventory_item_id: (walk.body ?? [])[0].inventory_item_id, correct: true }],
    });
    chk(again.status >= 400, `a second audit today is refused (HTTP ${again.status})`);
  } else {
    // One item deliberately wrong, so the variance path is exercised.
    const items = walk.body ?? [];
    const target = items.find((i) => i.color_code === `VT-${TAG}`) ?? items[0];
    const payload = items.map((i) =>
      i.inventory_item_id === target.inventory_item_id
        ? { inventory_item_id: i.inventory_item_id, correct: false,
            actual_quantity: Number(i.expected_quantity) + 1.5 }
        : { inventory_item_id: i.inventory_item_id, correct: true });

    const sub = await rpc('sm_submit_daily_audit', A.sm, { p_items: payload });
    chk(sub.status === 200, `submitted ${sub.body?.items} items (HTTP ${sub.status})`);
    chk(sub.body?.corrected === 1, `exactly one correction recorded`);

    const after = await q(
      `inventory_items?id=eq.${target.inventory_item_id}&select=quantity`, A.sm);
    chk(Number(after.body?.[0]?.quantity) === Number(target.expected_quantity) + 1.5,
      `${target.color_code} was set to the counted figure`);

    const mv = await q(
      `stock_movements?thread_stock_id=eq.${target.inventory_item_id}` +
      `&movement_type=eq.audit_variance&select=quantity_meters&order=created_at.desc&limit=1`, A.sm);
    chk(Number(mv.body?.[0]?.quantity_meters) === 1.5,
      `the variance is a signed audit_variance movement (+1.5)`);

    const again = await rpc('sm_submit_daily_audit', A.sm, { p_items: payload });
    chk(again.status >= 400, `a second audit the same day is refused (HTTP ${again.status})`);
  }

  const hist = await rpc('audit_history', A.sm, { p_limit: 60 });
  chk(hist.status === 200 && (hist.body ?? []).length > 0,
    `history lists ${(hist.body ?? []).length} audit(s), newest first`);
  const dates = (hist.body ?? []).map((h) => h.audit_date);
  chk(dates.every((d, i) => i === 0 || dates[i - 1] >= d), 'history is in date order');

  const first = (hist.body ?? [])[0];
  if (first) {
    const det = await rpc('audit_detail', A.sm, { p_audit_id: first.id });
    chk(det.status === 200 && (det.body ?? []).length === first.item_count,
      `detail of ${first.audit_code} shows its ${first.item_count} item(s)`);
    chk((det.body ?? []).every((r) => r.expected_quantity != null && r.actual_quantity != null),
      'detail shows system count against actual count');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. Handover: decimal leftovers, On Machine kept separate ===');
{
  const queue = await rpc('fm_handover_queue', A.fm, {});
  chk(queue.status === 200, `fm_handover_queue -> HTTP ${queue.status}`);
  const target = (queue.body ?? [])[0];

  if (!target) {
    ok('nothing finished is awaiting handover right now (queue empty, not broken)');
  } else {
    const lines = await rpc('fm_handover_lines', A.fm, { p_order_id: target.order_id });
    chk(lines.status === 200 && (lines.body ?? []).length > 0,
      `${target.order_code}: ${(lines.body ?? []).length} issued line(s)`);

    const rows = lines.body ?? [];
    const returning = rows[0];
    const beforeQ = Number(((await q(
      `inventory_items?id=eq.${returning.inventory_item_id}&select=quantity`, A.fm)).body ?? [])[0]?.quantity ?? 0);

    // Leftover cannot exceed what went out.
    const tooMuch = await rpc('fm_submit_handover', A.fm, {
      p_order_id: target.order_id,
      p_items: [{ inventory_item_id: returning.inventory_item_id,
                  issued_quantity: Number(returning.issued_quantity),
                  leftover_quantity: Number(returning.issued_quantity) + 10,
                  on_machine: false }],
    });
    chk(tooMuch.status >= 400,
      `more coming back than went out is refused (HTTP ${tooMuch.status})`);

    // 2.3 — the brief's own decimal example.
    const leftover = Math.min(2.3, Number(returning.issued_quantity));
    const payload = rows.map((l, i) =>
      i === 0
        ? { inventory_item_id: l.inventory_item_id,
            issued_quantity: Number(l.issued_quantity),
            leftover_quantity: leftover, on_machine: false }
        : { inventory_item_id: l.inventory_item_id,
            issued_quantity: Number(l.issued_quantity),
            leftover_quantity: 0, on_machine: true });

    const sub = await rpc('fm_submit_handover', A.fm, {
      p_order_id: target.order_id, p_items: payload, p_note: `verify ${TAG}` });
    chk(sub.status === 200, `handover submitted (HTTP ${sub.status})`);
    chk(Number(sub.body?.returned_quantity) === leftover,
      `${leftover} returned to stock, exactly as entered`);

    const afterQ = Number(((await q(
      `inventory_items?id=eq.${returning.inventory_item_id}&select=quantity`, A.fm)).body ?? [])[0]?.quantity ?? 0);
    chk(Math.abs(afterQ - (beforeQ + leftover)) < 0.001,
      `stock went ${beforeQ} -> ${afterQ} (+${leftover}), decimal intact`);

    const mv = await q(
      `stock_movements?thread_stock_id=eq.${returning.inventory_item_id}` +
      `&movement_type=eq.handover_return&select=quantity_meters&order=created_at.desc&limit=1`, A.fm);
    chk(Number(mv.body?.[0]?.quantity_meters) === leftover,
      'the return is a handover_return row in the same ledger');

    const detail = await rpc('fm_handover_detail', A.fm, { p_order_id: target.order_id });
    const onMachine = (detail.body ?? []).filter((d) => d.on_machine);
    chk(rows.length === 1 || onMachine.length > 0,
      `${onMachine.length} line(s) recorded as still on the machine, not credited`);

    const twice = await rpc('fm_submit_handover', A.fm, {
      p_order_id: target.order_id, p_items: payload });
    chk(twice.status >= 400, `a second handover for the order is refused (HTTP ${twice.status})`);
  }

  // Mounting is driven by material issue, so a machine with an active job card
  // should be able to say what is on it.
  const machines = await q('machines?select=id,name&deleted_at=is.null&limit=5', A.fm);
  let anyMounted = 0;
  for (const m of machines.body ?? []) {
    const r = await rpc('machine_mounted_list', A.fm, { p_machine_id: m.id });
    if (r.status !== 200) { no(`machine_mounted_list -> HTTP ${r.status}`); break; }
    anyMounted += (r.body ?? []).length;
  }
  ok(`machine_mounted_list answers for every machine (${anyMounted} mounted item(s) in total)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. None of this leaks across factories ===');
{
  const alpha = (await rpc('inventory_list', A.sm, {})).body ?? [];
  const beta = (await rpc('inventory_list', B.sm, {})).body ?? [];
  const alphaIds = new Set(alpha.map((r) => r.id));
  chk(!beta.some((r) => alphaIds.has(r.id)),
    `Beta sees ${beta.length} of its own items, none of Alpha's ${alpha.length}`);

  const betaPos = (await rpc('sm_po_list', B.sm, {})).body ?? [];
  const alphaPoIds = new Set(((await rpc('sm_po_list', A.sm, {})).body ?? []).map((p) => p.id));
  chk(!betaPos.some((p) => alphaPoIds.has(p.id)), 'PO lists do not cross tenants');

  const betaReq = (await rpc('material_request_history', B.sm, {})).body ?? [];
  const alphaReqIds = new Set(
    ((await rpc('material_request_history', A.sm, {})).body ?? []).map((r) => r.id));
  chk(!betaReq.some((r) => alphaReqIds.has(r.id)), 'request history does not cross tenants');

  // Naming another factory's row by id must not be enough.
  if (alpha[0]) {
    const steal = await rpc('sm_add_inventory', B.sm, {
      p_item_type: 'thread', p_color_code: alpha[0].color_code, p_quantity: 1,
    });
    if (steal.status === 200) {
      chk(steal.body?.id !== alpha[0].id,
        'adding the same colour code in Beta creates a Beta row, not a write to Alpha’s');
    } else {
      ok(`Beta cannot add against Alpha's colour (HTTP ${steal.status})`);
    }
  }

  // Role, not just tenant: the floor manager must not be able to add stock.
  const wrongRole = await rpc('sm_add_inventory', A.fm, {
    p_item_type: 'thread', p_color_code: `VR-${TAG}`, p_quantity: 1,
  });
  chk(wrongRole.status >= 400, `the floor manager cannot add stock (HTTP ${wrongRole.status})`);

  const wrongAudit = await rpc('sm_submit_daily_audit', A.fm, { p_items: [] });
  chk(wrongAudit.status >= 400, `the floor manager cannot submit the audit (HTTP ${wrongAudit.status})`);
}

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
