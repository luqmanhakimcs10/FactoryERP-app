/**
 * Stranded repeats + the write-off deadlock (migration 0063).
 *
 * Alpha factory. Run: node scripts/verify-escape-hatches.mjs
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
const q = async (p, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const msg = (r) => (r.body?.message ?? '').slice(0, 120);

const A = {
  ot: await login('order@alpha.test'), qa: await login('qa@alpha.test'),
  fm: await login('floor@alpha.test'), dp: await login('delivery@alpha.test'),
};
const B = { qa: await login('qa@beta.test'), fm: await login('floor@beta.test') };

console.log('\n============ ESCAPE HATCHES (0063) ============');
console.log('Factory: Alpha Embroidery Works\n');

// ---------------------------------------------------------------------------
console.log('=== 1. The second pipeline is gone ===');
{
  // These RPCs bypassed the 0056 loop and are what stranded repeats.
  for (const [fn, args] of [
    ['dp_handoff_queue', {}],
    ['dp_return_queue', {}],
    ['qa_collection_queue', {}],
    ['dp_confirm_handoff', { p_repeat_id: null, p_order_stage_id: null, p_photo_url: 'x' }],
    ['dp_confirm_return', { p_repeat_id: null, p_return_photo_url: 'x' }],
    ['qa_collection_pass', { p_repeat_id: null }],
  ]) {
    const r = await rpc(fn, A.dp, args);
    chk(r.status === 404, `${fn} is dropped (HTTP ${r.status})`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. No stranded repeats remain, and the remedy is self-service ===');
{
  const strandedOrders = await rpc('fm_stranded_repeat_orders', A.fm, {});
  chk(strandedOrders.status === 200, `fm_stranded_repeat_orders -> HTTP ${strandedOrders.status}`);
  chk((strandedOrders.body ?? []).length === 0,
    (strandedOrders.body ?? []).length === 0
      ? 'no order carries stranded repeats'
      : `STILL STRANDED: ${(strandedOrders.body ?? []).map((o) => `${o.order_code}(${o.stranded})`).join(', ')}`);

  // The nine that were repaired are now genuinely in the loop. One counted
  // query, not one per row — an earlier version of this fanned out per repeat
  // and ran the process out of memory.
  const adopted = await q(
    'repeat_stage_history?select=id&status=eq.in_progress&note=like.*Adopted%20into%20the%20stage%20loop*',
    A.fm);
  chk((adopted.body ?? []).length >= 9,
    `${(adopted.body ?? []).length} adoption event(s) in history — the repair is auditable, not silent`);

  // Any repeat still at the stranded signature, joined to its order in ONE go.
  const stuck = await q(
    'repeats?select=repeat_code,sheets!inner(orders!inner(order_code,status))' +
    '&current_status=eq.ready_for_production&current_stage_index=eq.0',
    A.fm);
  const inProd = (stuck.body ?? [])
    .filter((r) => ['in_production', 'in_finishing'].includes(r.sheets?.orders?.status))
    .map((r) => r.repeat_code);
  chk(inProd.length === 0,
    inProd.length === 0
      ? `no repeat is stranded on an in-production order (${(stuck.body ?? []).length} sit on orders that have not started, which is normal)`
      : `STILL STRANDED: ${inProd.join(', ')}`);

  // Role + tenant gates on the remedy.
  chk((await rpc('fm_stranded_repeat_orders', A.qa, {})).status >= 400,
    'QA cannot list stranded orders — this is a floor-manager remedy');
  const anyOrder = (await q('orders?select=id&status=eq.in_production&limit=1', A.fm)).body?.[0];
  if (anyOrder) {
    chk((await rpc('fm_adopt_stranded_repeats', B.fm, { p_order_id: anyOrder.id })).status === 404,
      "Beta's floor manager cannot adopt Alpha's repeats");
    const noop = await rpc('fm_adopt_stranded_repeats', A.fm, { p_order_id: anyOrder.id });
    chk(noop.status === 200 && noop.body?.repeats_adopted === 0,
      'adopting an order with nothing stranded is a safe no-op (0 adopted)');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Write-off: a piece the vendor never returns stops blocking ===');
let ORDER = null, SHEET = null, DAMAGE = null;
{
  // Build a clean subject: 2 pieces, one passed, one rejected and abandoned.
  const vendor = (await q('vendors?select=id&deleted_at=is.null&limit=1', A.ot)).body?.[0];
  const threads = ((await q('thread_stock?select=color_code&limit=2', A.qa)).body ?? []).map((t) => t.color_code);
  const made = await rpc('create_order', A.ot, {
    p_vendor_id: vendor.id,
    p_sheets: [{ sheet_number: 1, color_assignment: 'Writeoff', repeats_count: 2,
                 stitch_count: 3000, thread_color_codes: threads }],
    p_cloth_photos: ['alpha/wo.jpg'], p_design_sheet_url: 'alpha/wo-d.jpg',
  });
  ORDER = made.body;
  await rpc('submit_order', A.ot, { p_order_id: ORDER.id });
  let st = (await q(`orders?id=eq.${ORDER.id}&select=status`, A.qa)).body?.[0]?.status;
  if (st === 'awaiting_cloth_inspection') {
    await rpc('qa_accept_cloth', A.qa, { p_order_id: ORDER.id });
    st = (await q(`orders?id=eq.${ORDER.id}&select=status`, A.qa)).body?.[0]?.status;
  }
  chk(st === 'awaiting_coding', `${ORDER.order_code} is at repeat QA`);
  SHEET = (await q(`sheets?select=id&order_id=eq.${ORDER.id}`, A.qa)).body?.[0];

  const p1 = await rpc('qa_pass_piece', A.qa, {
    p_order_id: ORDER.id, p_sheet_id: SHEET.id, p_photo_url: 'alpha/wo-pass.jpg' });
  chk(p1.status === 200, `piece 1 passed -> ${p1.body?.repeat_code}`);

  const rej = await rpc('qa_reject_piece', A.qa, {
    p_order_id: ORDER.id, p_sheet_id: SHEET.id, p_damage_type: 'fabric',
    p_photo_url: 'alpha/wo-rej.jpg', p_scope: 'piece' });
  DAMAGE = rej.body?.damage_ids?.[0];
  chk(!!DAMAGE, 'piece 2 rejected — and the vendor is never going to send it back');

  const blocked = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: ORDER.id });
  chk(blocked.status >= 400, `THE DEADLOCK: job card blocked -> ${msg(blocked)}`);

  // Gates.
  chk((await rpc('qa_write_off_piece', A.fm, { p_damage_id: DAMAGE })).status >= 400,
    'the floor manager cannot write off a piece — that is QA\'s call');
  chk((await rpc('qa_write_off_piece', B.qa, { p_damage_id: DAMAGE })).status === 404,
    "Beta's QA cannot write off Alpha's piece");

  const wo = await rpc('qa_write_off_piece', A.qa, {
    p_damage_id: DAMAGE, p_note: 'Vendor confirmed the piece is lost' });
  chk(wo.status === 200 && wo.body?.recheck_state === 'written_off',
    `written off -> "${wo.body?.recheck_state}"`);
  chk(!!wo.body?.written_off_at && !!wo.body?.written_off_by,
    'who and when are recorded on the piece');
  chk(wo.body?.write_off_reason === 'Vendor confirmed the piece is lost', 'the reason is stored');
  chk(wo.body?.responsible_type === 'vendor',
    'the damage record still blames the vendor — writing off is not a retraction');

  chk((await rpc('qa_write_off_piece', A.qa, { p_damage_id: DAMAGE })).status >= 400,
    'writing off the same piece twice is refused');

  // THE POINT: the order can now move.
  const go = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: ORDER.id });
  chk(go.status === 200 && go.body?.status === 'awaiting_job_card',
    `DEADLOCK BROKEN: continue to job card -> "${go.body?.status}"`);

  const counts = await rpc('sheet_piece_counts', A.qa, { p_sheet_id: SHEET.id });
  const c = Array.isArray(counts.body) ? counts.body[0] : counts.body;
  chk(c.outstanding === 0 && c.coded === 1 && c.held === 1,
    `sheet accounts for both slots: ${c.coded} coded + ${c.held} closed, ${c.outstanding} outstanding`);

  // The Order Taker must not still be asked to hand back a piece that has been
  // formally abandoned. It stays on the board as a record, but in COMPLETED.
  const board = await rpc('ot_return_repeats', A.ot, {});
  const row = (board.body ?? []).find((r) => r.damage_id === DAMAGE);
  chk(!!row && row.bucket === 'completed',
    `the written-off piece moved to the "${row?.bucket}" bucket — no longer an open task`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. All-written-off: cancel, rather than a relocated deadlock ===');
{
  const vendor = (await q('vendors?select=id&deleted_at=is.null&limit=1', A.ot)).body?.[0];
  const threads = ((await q('thread_stock?select=color_code&limit=2', A.qa)).body ?? []).map((t) => t.color_code);
  const made = await rpc('create_order', A.ot, {
    p_vendor_id: vendor.id,
    p_sheets: [{ sheet_number: 1, color_assignment: 'AllLost', repeats_count: 2,
                 stitch_count: 3000, thread_color_codes: threads }],
    p_cloth_photos: ['alpha/al.jpg'], p_design_sheet_url: 'alpha/al-d.jpg',
  });
  const bad = made.body;
  await rpc('submit_order', A.ot, { p_order_id: bad.id });
  let st = (await q(`orders?id=eq.${bad.id}&select=status`, A.qa)).body?.[0]?.status;
  if (st === 'awaiting_cloth_inspection') {
    await rpc('qa_accept_cloth', A.qa, { p_order_id: bad.id });
    st = (await q(`orders?id=eq.${bad.id}&select=status`, A.qa)).body?.[0]?.status;
  }

  if (st !== 'awaiting_coding') {
    console.log(`  ..    ${bad.order_code} sits at "${st}" — cannot probe on this run`);
  } else {
    const sheet = (await q(`sheets?select=id&order_id=eq.${bad.id}`, A.qa)).body?.[0];
    const rej = await rpc('qa_reject_piece', A.qa, {
      p_order_id: bad.id, p_sheet_id: sheet.id, p_damage_type: 'fabric',
      p_photo_url: 'alpha/al-rej.jpg', p_scope: 'sheet' });
    chk(rej.status === 200, `${bad.order_code}: every piece rejected (${rej.body?.count})`);

    for (const d of rej.body.damage_ids) {
      await rpc('qa_write_off_piece', A.qa, { p_damage_id: d, p_note: 'Lost in transit' });
    }
    const wo = await q(
      `damage_records?order_id=eq.${bad.id}&stage_type=eq.repeat_qa&select=recheck_state`, A.qa);
    chk((wo.body ?? []).every((d) => d.recheck_state === 'written_off'),
      'every piece written off');

    // Still refused — correctly. An empty order must not reach the floor.
    const stuck = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: bad.id });
    chk(stuck.status >= 400 && /no passed pieces/i.test(msg(stuck)),
      `job card still refused, and rightly -> ${msg(stuck)}`);

    // The honest resolution.
    chk((await rpc('fm_cancel_order', A.fm, { p_order_id: bad.id, p_reason: '  ' })).status >= 400,
      'cancelling without a reason is refused');
    chk((await rpc('fm_cancel_order', A.ot, { p_order_id: bad.id, p_reason: 'x' })).status >= 400,
      'the order taker cannot cancel — their board is read-only after submission');
    chk((await rpc('fm_cancel_order', B.fm, { p_order_id: bad.id, p_reason: 'x' })).status === 404,
      "Beta's floor manager cannot cancel Alpha's order");

    const cancelled = await rpc('fm_cancel_order', A.fm, {
      p_order_id: bad.id, p_reason: 'Every piece lost by the vendor; nothing to produce' });
    chk(cancelled.status === 200 && cancelled.body?.status === 'cancelled',
      `${bad.order_code} cancelled -> "${cancelled.body?.status}"`);
    chk(!!cancelled.body?.cancelled_at && !!cancelled.body?.cancel_reason,
      `reason and timestamp recorded: "${cancelled.body?.cancel_reason?.slice(0, 45)}…"`);

    chk((await rpc('fm_cancel_order', A.fm, { p_order_id: bad.id, p_reason: 'again' })).status >= 400,
      'cancelling twice is refused');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Cancel cannot be used to erase real work ===');
{
  const done = await q(
    'orders?select=id,order_code,status&status=in.(completed,ready_for_delivery)&limit=1', A.fm);
  if (done.body?.[0]) {
    const r = await rpc('fm_cancel_order', A.fm, {
      p_order_id: done.body[0].id, p_reason: 'should not work' });
    chk(r.status >= 400,
      `${done.body[0].order_code} (${done.body[0].status}) cannot be cancelled -> ${msg(r)}`);
  } else {
    console.log('  ..    no finished order available to probe with');
  }

  const invoiced = await q('invoices?select=order_id&status=neq.cancelled&limit=1', A.fm);
  if (invoiced.body?.[0]) {
    const r = await rpc('fm_cancel_order', A.fm, {
      p_order_id: invoiced.body[0].order_id, p_reason: 'should not work' });
    chk(r.status >= 400, `an invoiced order cannot be cancelled -> ${msg(r)}`);
  }
}

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
