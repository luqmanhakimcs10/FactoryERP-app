/**
 * Per-needle stitches and per-colour thread requirements (migration 0082).
 *
 * Drives a REAL order to a confirmed job card with two colours, deliberately
 * understocks ONE of them, and checks the resulting PO asks for the right
 * shortfall for that colour and nothing for the other. That last part is the
 * whole point of the brief: an aggregate estimate would also produce "a PO", so
 * only checking that one appears proves nothing.
 *
 * Alpha factory. Run: node scripts/verify-needle-stitches.mjs
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL, KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const PHOTO = 'alpha/needle/photo.jpg';
const PER_CONE = 350000;

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('  ..    ' + m);
const bail = (m) => { console.log('\n  STOPPED: ' + m + '\n'); process.exit(1); };

const T = {};
const login = async (who) => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${who}@alpha.test`, password: 'Password123!' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed: ${who}`);
  T[who] = j.access_token;
};
const rpc = async (who, name, args = {}) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${T[who]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body, msg: body?.message ?? '' };
};
const get = async (who, path) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${T[who]}` },
  });
  return (await r.json().catch(() => null)) ?? [];
};

console.log('\n====== PER-NEEDLE STITCHES / PER-COLOUR THREAD (0082) ======');
console.log('Factory: Alpha Embroidery Works\n');

for (const w of ['order', 'qa', 'floor', 'store', 'procurement', 'owner']) await login(w);

{
  const probe = await rpc('floor', 'order_color_requirements', {
    p_order_id: '00000000-0000-0000-0000-000000000000',
  });
  if (probe.status === 404) {
    console.log('  ----  Migration 0082 is NOT applied. `order_color_requirements`');
    console.log('        returned 404, so nothing below can run.\n');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
console.log('=== 1. A needle line cannot be added without stitches ===');
{
  const old = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: '00000000-0000-0000-0000-000000000000',
    p_thread_color_code: 'RED-01',
  });
  // The 2-arg overload is dropped, so PostgREST cannot resolve it at all.
  chk(old.status === 404,
    `the old 2-arg fm_add_job_card_line is gone (HTTP ${old.status}) — nothing can add a stitch-less line`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Set up: two colours, one of them deliberately short ===');

const RICH = 'RED-01';                       // plenty in stock
const SHORT = 'NEEDLE-SHORT';                // created at a known low level

// Two very different stitch loads, so an EVEN split would give a visibly
// different answer from the real per-needle one.
const RICH_STITCHES = 20000;
const SHORT_STITCHES = 900000;
const REPEATS = 2;

const shortStock = 1; // cones
{
  const inv = await get('store', `inventory_items?select=id,quantity&item_type=eq.thread&color_code=eq.${SHORT}`);
  if (inv.length === 0) {
    const a = await rpc('store', 'sm_add_inventory', {
      p_item_type: 'thread', p_color_code: SHORT, p_quantity: shortStock,
      p_note: 'verify-needle-stitches: deliberately low',
    });
    if (!a.ok) bail(`could not create the understocked colour: ${a.msg}`);
  }
  const now = await get('store', `inventory_items?select=quantity&item_type=eq.thread&color_code=eq.${SHORT}`);
  info(`${SHORT} is at ${Number(now[0]?.quantity ?? 0)} cone(s) — deliberately low`);
  const rich = await get('store', `inventory_items?select=quantity&item_type=eq.thread&color_code=eq.${RICH}`);
  info(`${RICH} is at ${Number(rich[0]?.quantity ?? 0).toLocaleString()} — plenty`);
}

const vendors = await get('order', 'vendors?select=id&deleted_at=is.null&limit=1');
if (!vendors.length) bail('no client master');

const created = await rpc('order', 'create_order', {
  p_vendor_id: vendors[0].id,
  p_sheets: [{ color_assignment: 'Needle stitches test', repeats_count: REPEATS,
               stitch_count: 1000, thread_color_codes: [RICH] }],
  p_cloth_photos: [PHOTO], p_design_sheet_url: null,
});
if (!created.ok) bail(`create_order: ${created.msg}`);
const orderId = created.body?.id ?? created.body?.order_id;
const orderCode = created.body?.order_code;

const sub = await rpc('order', 'submit_order', { p_order_id: orderId });
if (!sub.ok) bail(`submit_order: ${sub.msg}`);
info(`${orderCode} submitted -> ${sub.body?.status} (sheet-level estimate; no needle data exists yet)`);

if (!(await rpc('qa', 'qa_accept_cloth', { p_order_id: orderId })).ok) bail('qa_accept_cloth');
const sheets = await get('qa', `sheets?order_id=eq.${orderId}&select=id,repeats_count`);
for (const s of sheets) {
  for (let i = 0; i < s.repeats_count; i++) {
    const p = await rpc('qa', 'qa_pass_piece', { p_order_id: orderId, p_sheet_id: s.id, p_photo_url: PHOTO });
    if (!p.ok) bail(`qa_pass_piece: ${p.msg}`);
  }
}
if (!(await rpc('qa', 'qa_complete_repeat_qa', { p_order_id: orderId })).ok) bail('qa_complete_repeat_qa');

const partners = await get('floor', 'finishing_partners?select=id,stage_type&deleted_at=is.null&limit=1');
const st = partners[0]?.stage_type ?? 'embroidery';
if (!(await rpc('floor', 'fm_set_stage_sequence', {
  p_order_id: orderId,
  p_stages: [{ stage_type: st, is_outsourced: false, sla_hours: 24, partner_id: null }],
})).ok) bail('fm_set_stage_sequence');
if (!(await rpc('floor', 'fm_save_job_card_design', {
  p_order_id: orderId, p_design_code: 'NEEDLE-01', p_stitches_per_repeat: 1000 })).ok) {
  bail('fm_save_job_card_design');
}
if (!(await rpc('floor', 'fm_generate_job_card', { p_order_id: orderId })).ok) bail('fm_generate_job_card');
const card = (await get('floor', `job_cards?order_id=eq.${orderId}&select=id`))[0];

// ---------------------------------------------------------------------------
console.log('\n=== 3. Stitches save, and reach the Job Card table ===');
{
  const existing = await get('floor', `job_card_lines?job_card_id=eq.${card.id}&select=id`);
  for (const l of existing) {
    await rpc('floor', 'fm_delete_job_card_line', { p_job_card_id: card.id, p_line_id: l.id });
  }

  const bad = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: card.id, p_thread_color_code: RICH, p_stitch_count: 0,
  });
  chk(!bad.ok, `zero stitches is refused (HTTP ${bad.status})`);

  const a = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: card.id, p_thread_color_code: RICH, p_stitch_count: RICH_STITCHES });
  chk(a.ok && Number(a.body?.stitch_count) === RICH_STITCHES,
    `needle 1: ${RICH} at ${RICH_STITCHES.toLocaleString()} stitches`);

  const b = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: card.id, p_thread_color_code: SHORT, p_stitch_count: SHORT_STITCHES });
  chk(b.ok && Number(b.body?.stitch_count) === SHORT_STITCHES,
    `needle 2: ${SHORT} at ${SHORT_STITCHES.toLocaleString()} stitches`);

  // The Job Card detail table reads job_card_lines directly — this is the same
  // data it renders, so a non-null value here IS the column no longer showing 0.
  const lines = await get('floor', `job_card_lines?job_card_id=eq.${card.id}&select=needle_number,thread_color_code,stitch_count&order=needle_number`);
  chk(lines.length === 2 && lines.every((l) => l.stitch_count > 0),
    `the table's Stitches column has real values: ${lines.map((l) => l.stitch_count).join(', ')}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Per-colour requirement, computed per needle ===');
{
  const req = await rpc('floor', 'order_color_requirements', { p_order_id: orderId });
  chk(req.ok, `order_color_requirements -> HTTP ${req.status}`);
  const rows = req.body ?? [];
  const byColor = Object.fromEntries(rows.map((r) => [r.color_code, r]));

  const expRich = Math.ceil((RICH_STITCHES * REPEATS) / PER_CONE);
  const expShort = Math.ceil((SHORT_STITCHES * REPEATS) / PER_CONE);

  chk(Number(byColor[RICH]?.total_stitches) === RICH_STITCHES * REPEATS,
    `${RICH}: ${RICH_STITCHES.toLocaleString()} x ${REPEATS} repeats = ${(RICH_STITCHES * REPEATS).toLocaleString()} stitches`);
  chk(Number(byColor[SHORT]?.total_stitches) === SHORT_STITCHES * REPEATS,
    `${SHORT}: ${SHORT_STITCHES.toLocaleString()} x ${REPEATS} repeats = ${(SHORT_STITCHES * REPEATS).toLocaleString()} stitches`);

  chk(byColor[RICH]?.cones_needed === expRich, `${RICH} needs ${expRich} cone(s) at 350,000/cone`);
  chk(byColor[SHORT]?.cones_needed === expShort, `${SHORT} needs ${expShort} cone(s) at 350,000/cone`);

  // The two colours must come out DIFFERENT. An even split would make them
  // equal, which is exactly the estimate this replaces.
  chk(byColor[RICH]?.cones_needed !== byColor[SHORT]?.cones_needed,
    'the two colours differ — this is per-needle, not an even split of one total');

  chk(byColor[RICH]?.cones_short === 0, `${RICH} is not short (plenty in stock)`);
  chk(byColor[SHORT]?.cones_short === expShort - Math.floor(shortStock),
    `${SHORT} is short by ${byColor[SHORT]?.cones_short} = ${expShort} needed - ${Math.floor(shortStock)} held`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. Asking for material orders the exact shortfall ===');
{
  if (!(await rpc('floor', 'fm_mark_vendor_informed', { p_order_id: orderId })).ok) {
    bail('fm_mark_vendor_informed');
  }
  const asked = await rpc('floor', 'fm_ask_for_material', { p_order_id: orderId });
  chk(asked.ok, `fm_ask_for_material -> HTTP ${asked.status} ${asked.ok ? '' : asked.msg}`);

  const pos = await get('floor', `purchase_orders?order_id=eq.${orderId}&select=id,po_code,origin,status`);
  chk(pos.length === 1,
    `exactly ONE purchase order for this order (${pos.length}) — the estimate's PO was extended, not duplicated`);

  const items = await get('floor', `po_items?purchase_order_id=eq.${pos[0]?.id}&select=color_code,quantity_meters`);
  const byColor = Object.fromEntries(items.map((i) => [i.color_code, Number(i.quantity_meters)]));
  const expShort = Math.ceil((SHORT_STITCHES * REPEATS) / PER_CONE) - Math.floor(shortStock);

  chk(byColor[SHORT] === expShort,
    `the PO asks for ${byColor[SHORT]} cone(s) of ${SHORT} (expected ${expShort})`);
  chk(byColor[RICH] === undefined,
    `and asks for NOTHING of ${RICH} — only the colour that is actually short`);

  console.log(`\n  ${orderCode}: PO ${pos[0]?.po_code} -> ` +
    Object.entries(byColor).map(([c, q]) => `${c}=${q}`).join(', '));
}


// ---------------------------------------------------------------------------
console.log('\n=== 6. Generated lines are not born at zero (0083) ===');
{
  // fm_generate_job_card derived a line's stitches from sheets.stitch_count,
  // which is 0 on every sheet in this database, while the Builder's own
  // "stitches per repeat" — the field people actually fill in — was ignored.
  // Every needle line came out 0 and the whole chain below it read zero.
  const lines2 = await get('floor', `job_card_lines?job_card_id=eq.${card.id}&select=stitch_count`);
  chk(lines2.length > 0 && lines2.every((l) => Number(l.stitch_count) > 0),
    `every needle line has a real stitch count: ${lines2.map((l) => l.stitch_count).join(', ')}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. Issue Materials reports the real requirement and refuses ===');
{
  const req = await rpc('store', 'job_card_requirements', { p_job_card_id: card.id });
  chk(req.ok, `job_card_requirements -> HTTP ${req.status}`);
  const rows = req.body ?? [];
  const short = rows.find((r) => r.color_code === SHORT);

  chk(Number(short?.required_meters) > 0,
    `${SHORT} shows a real Required (${short?.required_meters}), not 0`);
  chk(short?.sufficient === false,
    `${SHORT} is flagged insufficient (${short?.available_meters} held)`);

  // The DATABASE must refuse, not only the screen. A requirement of 0 used to
  // pass `available >= required` and issue nothing while reporting success.
  const issued = await rpc('store', 'sm_issue_materials', { p_job_card_id: card.id });
  chk(!issued.ok && /Not enough thread/i.test(issued.msg),
    `sm_issue_materials refuses in the database: "${issued.msg.slice(0, 70)}"`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. The owner sees the PO awaiting them (0083) ===');
{
  const po = (await get('floor', `purchase_orders?order_id=eq.${orderId}&select=id,po_code,status`))[0];
  if (!po) {
    no('no PO on this order to approve');
  } else {
    await rpc('procurement', 'po_execute', { p_po_id: po.id });
    const bill = await rpc('procurement', 'po_upload_bill', {
      p_po_id: po.id, p_bill_url: 'alpha/verify/bill.jpg', p_amount: 1234,
    });
    if (!bill.ok) info(`could not move ${po.po_code} on: ${bill.msg.slice(0, 60)}`);

    const queue = await rpc('owner', 'owner_approvals_queue', {});
    const mine = (queue.body ?? []).find((a) => a.kind === 'purchase_order' && a.id === po.id);
    chk(!!mine, `${po.po_code} appears in the owner's approvals inbox`);
    if (mine) {
      chk(String(mine.title).includes(po.po_code), `the row names the real PO: "${mine.title}"`);
      chk(Number(mine.amount) === 1234, `and its real amount (${mine.amount}), not a placeholder`);
      chk(/ x /.test(String(mine.subtitle)), `and its real lines: "${mine.subtitle}"`);
    }
  }
}

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
