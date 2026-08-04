/**
 * The repeat-QA reject -> return -> re-inspect loop (migration 0059).
 *
 * The bug being guarded against: a rejected piece used to count as "resolved",
 * so "Continue to job card" lit up and an order with nothing usable on it went
 * to production. This proves the gate now holds until the piece has physically
 * gone back to the vendor, come back, and PASSED.
 *
 * Run:  node scripts/verify-repeat-qa-loop.mjs
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

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
const msg = (r) => (r.body?.message ?? '').slice(0, 110);

const A = {
  qa: await login('qa@alpha.test'),
  ot: await login('order@alpha.test'),
  fm: await login('floor@alpha.test'),
};
const B = { ot: await login('order@beta.test'), qa: await login('qa@beta.test') };

console.log('\n============ REPEAT QA: reject -> return -> re-inspect (0059) ============');

// ---------------------------------------------------------------------------
// 0. Find an order sitting at repeat QA with an uninspected piece.
// ---------------------------------------------------------------------------
console.log('\n=== 0. Pick an order at awaiting_coding ===');
let ORDER = null, SHEET = null;
{
  const orders = await q('orders?select=id,order_code&status=eq.awaiting_coding&order=created_at.desc', A.qa);
  for (const o of orders.body ?? []) {
    const sh = await q(`sheets?select=id,sheet_number,color_assignment,repeats_count&order_id=eq.${o.id}&order=sheet_number`, A.qa);
    for (const s of sh.body ?? []) {
      const c = await rpc('sheet_piece_counts', A.qa, { p_sheet_id: s.id });
      const row = Array.isArray(c.body) ? c.body[0] : c.body;
      if ((row?.coded ?? 0) + (row?.held ?? 0) < s.repeats_count) {
        ORDER = o; SHEET = { ...s, counts: row };
        break;
      }
    }
    if (ORDER) break;
  }
  // Nothing spare? Make one. Hunting for a leftover order made this script
  // pass or fail depending on what previous runs happened to leave behind —
  // creating its own subject makes it repeatable.
  if (!ORDER) {
    console.log('  ..    no spare order with a free slot — creating one');
    const vendor = (await q('vendors?select=id&deleted_at=is.null&limit=1', A.ot)).body?.[0];
    const threads = ((await q('thread_stock?select=color_code&limit=2', A.qa)).body ?? [])
      .map((t) => t.color_code);
    const made = await rpc('create_order', A.ot, {
      p_vendor_id: vendor.id,
      p_sheets: [{ sheet_number: 1, color_assignment: 'Recheck Loop', repeats_count: 2,
                   stitch_count: 4000, thread_color_codes: threads }],
      p_cloth_photos: ['alpha/rl-cloth.jpg'], p_design_sheet_url: 'alpha/rl-design.jpg',
    });
    await rpc('submit_order', A.ot, { p_order_id: made.body.id });
    let st = (await q(`orders?id=eq.${made.body.id}&select=status`, A.qa)).body?.[0]?.status;
    if (st === 'awaiting_cloth_inspection') {
      await rpc('qa_accept_cloth', A.qa, { p_order_id: made.body.id });
      st = (await q(`orders?id=eq.${made.body.id}&select=status`, A.qa)).body?.[0]?.status;
    }
    if (st === 'awaiting_coding') {
      const s = (await q(`sheets?select=id,sheet_number,color_assignment,repeats_count&order_id=eq.${made.body.id}`, A.qa)).body?.[0];
      const c = await rpc('sheet_piece_counts', A.qa, { p_sheet_id: s.id });
      ORDER = made.body;
      SHEET = { ...s, counts: Array.isArray(c.body) ? c.body[0] : c.body };
    }
  }

  chk(!!ORDER, ORDER
    ? `order ${ORDER.order_code}, sheet ${SHEET.sheet_number} "${SHEET.color_assignment}" (${SHEET.repeats_count} piece(s), ${SHEET.counts.coded} coded, ${SHEET.counts.held} held)`
    : 'could not find or create an order at awaiting_coding with a free piece slot');
}
if (!ORDER) { console.log('\nNothing to test against. Stopping.'); process.exit(1); }

// ---------------------------------------------------------------------------
// 1. Reject a piece. The job card must now be BLOCKED.
// ---------------------------------------------------------------------------
console.log('\n=== 1. Rejecting a piece blocks "Continue to job card" ===');
let DAMAGE_ID = null;
{
  const rej = await rpc('qa_reject_piece', A.qa, {
    p_order_id: ORDER.id, p_sheet_id: SHEET.id,
    p_damage_type: 'fabric', p_photo_url: 'alpha/qa-reject.jpg',
    p_note: 'recheck-loop verification', p_scope: 'piece',
  });
  DAMAGE_ID = rej.body?.damage_ids?.[0];
  chk(rej.status === 200 && !!DAMAGE_ID, `piece rejected -> damage ${String(DAMAGE_ID).slice(0, 8)}`);

  const d = await q(`damage_records?id=eq.${DAMAGE_ID}&select=recheck_state`, A.qa);
  chk(d.body?.[0]?.recheck_state === 'awaiting_return',
    `damage row opens the loop at "${d.body?.[0]?.recheck_state}"`);

  const blocked = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: ORDER.id });
  chk(blocked.status >= 400 && /return loop|awaiting a decision|no passed pieces/i.test(msg(blocked)),
    `THE FIX: "Continue to job card" is refused -> ${msg(blocked)}`);

  const st = await q(`orders?id=eq.${ORDER.id}&select=status`, A.qa);
  chk(st.body?.[0]?.status === 'awaiting_coding',
    `order stayed at "${st.body?.[0]?.status}" — so it is still in QA's own queue, no new status needed`);
}

// ---------------------------------------------------------------------------
// 2. QA cannot re-inspect until the Order Taker has actually returned it.
// ---------------------------------------------------------------------------
console.log('\n=== 2. QA cannot skip the return leg ===');
{
  const early = await rpc('qa_recheck_piece', A.qa, {
    p_damage_id: DAMAGE_ID, p_pass: true, p_photo_url: 'alpha/x.jpg',
  });
  chk(early.status >= 400 && /not back from the vendor/i.test(msg(early)),
    `re-inspecting before the return is refused -> ${msg(early)}`);
}

// ---------------------------------------------------------------------------
// 3. The Order Taker sees it, and completing the return needs a photo.
// ---------------------------------------------------------------------------
console.log('\n=== 3. Order Taker completes the return (photo required) ===');
{
  const board = await rpc('ot_return_repeats', A.ot, {});
  const row = (board.body ?? []).find((r) => r.damage_id === DAMAGE_ID);
  chk(!!row && row.bucket === 'active',
    `it is on the Order Taker's ACTIVE returns as "${row?.reason}" (piece ${row?.piece_index} of ${row?.piece_total})`);

  chk((await rpc('ot_complete_qa_return', A.ot, { p_damage_id: DAMAGE_ID, p_photo_url: '  ' })).status >= 400,
    'completing the return without a photo is refused');
  chk((await rpc('ot_complete_qa_return', B.ot, { p_damage_id: DAMAGE_ID, p_photo_url: 'x.jpg' })).status === 404,
    "Beta's order taker cannot complete Alpha's return");

  const done = await rpc('ot_complete_qa_return', A.ot,
    { p_damage_id: DAMAGE_ID, p_photo_url: 'alpha/vendor-handback.jpg' });
  chk(done.status === 200 && done.body?.recheck_state === 'awaiting_recheck',
    `return completed -> "${done.body?.recheck_state}" (now back with QA)`);

  const still = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: ORDER.id });
  chk(still.status >= 400,
    'job card STILL blocked — the piece is back but has not passed QA yet');
}

// ---------------------------------------------------------------------------
// 4. It reappears for QA. Reject again -> the loop restarts.
// ---------------------------------------------------------------------------
console.log('\n=== 4. Re-inspect: rejecting again restarts the round trip ===');
let SECOND_ID = null;
{
  const dmg = await q(
    `damage_records?order_id=eq.${ORDER.id}&stage_type=eq.repeat_qa&recheck_state=eq.awaiting_recheck&select=id`, A.qa);
  chk((dmg.body ?? []).some((d) => d.id === DAMAGE_ID),
    "the piece is visible to QA as awaiting re-inspection on the order it belongs to");

  chk((await rpc('qa_recheck_piece', A.ot, { p_damage_id: DAMAGE_ID, p_pass: true, p_photo_url: 'x.jpg' })).status >= 400,
    'the order taker cannot re-inspect — that is QA’s call');
  chk((await rpc('qa_recheck_piece', A.qa, { p_damage_id: DAMAGE_ID, p_pass: true, p_photo_url: '' })).status >= 400,
    're-inspecting without a photo is refused');
  chk((await rpc('qa_recheck_piece', B.qa, { p_damage_id: DAMAGE_ID, p_pass: true, p_photo_url: 'x.jpg' })).status === 404,
    "Beta's QA cannot re-inspect Alpha's piece");

  const again = await rpc('qa_recheck_piece', A.qa, {
    p_damage_id: DAMAGE_ID, p_pass: false, p_photo_url: 'alpha/reject-2.jpg',
    p_damage_type: 'stains', p_note: 'still not right',
  });
  SECOND_ID = again.body?.replacement_damage_id;
  chk(again.status === 200 && again.body?.outcome === 'rejected' && !!SECOND_ID,
    `rejected again -> a fresh damage row ${String(SECOND_ID).slice(0, 8)} takes the slot`);

  const old = await q(`damage_records?id=eq.${DAMAGE_ID}&select=recheck_state`, A.qa);
  chk(old.body?.[0]?.recheck_state === 'superseded',
    `the first rejection is kept as "${old.body?.[0]?.recheck_state}" for the audit trail`);

  // THE COUNTING TRAP: one physical piece, two damage rows. The sheet must not
  // suddenly claim it has more pieces than it physically does.
  const c = await rpc('sheet_piece_counts', A.qa, { p_sheet_id: SHEET.id });
  const row = Array.isArray(c.body) ? c.body[0] : c.body;
  chk(row.coded + row.held <= SHEET.repeats_count,
    `sheet still accounts for ${row.coded + row.held} of ${SHEET.repeats_count} slots — the bounce did not inflate it`);

  const board = await rpc('ot_return_repeats', A.ot, {});
  const stale = (board.body ?? []).find((r) => r.damage_id === DAMAGE_ID);
  const fresh = (board.body ?? []).find((r) => r.damage_id === SECOND_ID);
  chk(!stale, 'the superseded row is gone from the Order Taker’s board');
  chk(!!fresh && fresh.bucket === 'active', 'the replacement is on the board as a new active return');
}

// ---------------------------------------------------------------------------
// 5. Second time round: return it, pass it, and only THEN the job card opens.
// ---------------------------------------------------------------------------
console.log('\n=== 5. Return it, pass it, job card unlocks ===');
{
  const back = await rpc('ot_complete_qa_return', A.ot,
    { p_damage_id: SECOND_ID, p_photo_url: 'alpha/handback-2.jpg' });
  chk(back.status === 200 && back.body?.recheck_state === 'awaiting_recheck', 'returned a second time');

  const passed = await rpc('qa_recheck_piece', A.qa, {
    p_damage_id: SECOND_ID, p_pass: true, p_photo_url: 'alpha/repass.jpg',
  });
  chk(passed.status === 200 && passed.body?.outcome === 'passed' && !!passed.body?.repeat_code,
    `QA passed it -> coded as ${passed.body?.repeat_code}`);

  const dRow = await q(`damage_records?id=eq.${SECOND_ID}&select=recheck_state`, A.qa);
  chk(dRow.body?.[0]?.recheck_state === 'passed', 'the damage row closed as "passed", releasing its slot');

  const dRow2 = await q(`damage_records?id=eq.${SECOND_ID}&select=recheck_state`, A.qa);
  chk(dRow2.body?.[0]?.recheck_state === 'passed', 'the piece we walked is fully closed');

  // This order may carry OTHER unfinished pieces — uninspected slots, and
  // rejections left behind by earlier test runs. Clear every one of them, or
  // the final assertion would be testing the wrong blocker. (Which is exactly
  // what happened on the first run of this script: the gate stayed shut because
  // of a pre-existing rejection, and it was right to.)
  const sheets = await q(`sheets?select=id,sheet_number,repeats_count&order_id=eq.${ORDER.id}`, A.qa);

  for (let sweep = 0; sweep < 8; sweep++) {
    const open = await q(
      `damage_records?order_id=eq.${ORDER.id}&stage_type=eq.repeat_qa&repeat_id=is.null` +
      `&recheck_state=in.(awaiting_return,awaiting_recheck)&select=id,recheck_state`, A.qa);
    if ((open.body ?? []).length === 0) break;
    for (const d of open.body) {
      if (d.recheck_state === 'awaiting_return') {
        await rpc('ot_complete_qa_return', A.ot, { p_damage_id: d.id, p_photo_url: 'alpha/sweep.jpg' });
      }
      await rpc('qa_recheck_piece', A.qa, { p_damage_id: d.id, p_pass: true, p_photo_url: 'alpha/sweep-pass.jpg' });
    }
  }

  for (const s of sheets.body ?? []) {
    for (let guard = 0; guard < 12; guard++) {
      const cc = await rpc('sheet_piece_counts', A.qa, { p_sheet_id: s.id });
      const r2 = Array.isArray(cc.body) ? cc.body[0] : cc.body;
      if (r2.coded + r2.held >= s.repeats_count) break;
      const p = await rpc('qa_pass_piece', A.qa,
        { p_order_id: ORDER.id, p_sheet_id: s.id, p_photo_url: 'alpha/fill.jpg' });
      if (p.status !== 200) break;
    }
  }

  let outstandingTotal = 0;
  for (const s of sheets.body ?? []) {
    const cc = await rpc('sheet_piece_counts', A.qa, { p_sheet_id: s.id });
    const r2 = Array.isArray(cc.body) ? cc.body[0] : cc.body;
    outstandingTotal += r2.outstanding;
  }
  chk(outstandingTotal === 0, `every piece on ${ORDER.order_code} is now passed or closed`);

  const go = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: ORDER.id });
  chk(go.status === 200 && go.body?.status === 'awaiting_job_card',
    `THE GATE OPENS: continue to job card -> "${go.body?.status}"`);
}

// ---------------------------------------------------------------------------
// 6. An order whose every piece was rejected can never reach the job card.
// ---------------------------------------------------------------------------
console.log('\n=== 6. Regression: an all-rejected order cannot reach the job card ===');
{
  const orders = await q('orders?select=id,order_code&status=eq.awaiting_coding&order=created_at.desc', A.qa);
  let target = null;
  for (const o of orders.body ?? []) {
    if (o.id === ORDER.id) continue;
    const sh = await q(`sheets?select=id,repeats_count&order_id=eq.${o.id}`, A.qa);
    if ((sh.body?.length ?? 0) === 1) {
      const c = await rpc('sheet_piece_counts', A.qa, { p_sheet_id: sh.body[0].id });
      const r = Array.isArray(c.body) ? c.body[0] : c.body;
      if (r.coded === 0 && r.coded + r.held < sh.body[0].repeats_count) {
        target = { order: o, sheet: sh.body[0] };
        break;
      }
    }
  }
  if (!target) {
    console.log('  ..    no untouched single-sheet order spare — covered by section 1 instead');
  } else {
    await rpc('qa_reject_piece', A.qa, {
      p_order_id: target.order.id, p_sheet_id: target.sheet.id,
      p_damage_type: 'fabric', p_photo_url: 'alpha/all-reject.jpg', p_scope: 'sheet',
    });
    const r = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: target.order.id });
    chk(r.status >= 400,
      `${target.order.order_code}: every piece rejected -> job card refused (${msg(r)})`);
  }
}

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
