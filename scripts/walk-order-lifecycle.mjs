/**
 * Full order lifecycle walk — creates a REAL order and drives it end to end,
 * signing in as the role that actually performs each step.
 *
 *   node scripts/walk-order-lifecycle.mjs [alpha|beta]
 *
 * Covers, in order: create order (order_taker) → submit → cloth inspection (qa)
 * → piece-by-piece repeat QA with one piece REJECTED (qa) → stage sequence +
 * job card (floor_manager) → NEEDLE LINES added one at a time, capped at 6,
 * renumbering on delete → CLIENT INFORMED (must confirm the card) → ASK FOR
 * MATERIAL → issue materials (store_manager) → accept inventory (floor_manager)
 * → assign machine → START PRODUCTION → the per-repeat stage loop, with Pass QA
 * / Mark damage exercised from a genuine `qa@` session and refused from a
 * genuine `floor@` one → last stage passes → awaiting_final_qa → the Initial-QA
 * REJECTION surfacing in the order taker's Active returns and completing
 * through to Completed returns.
 *
 * Anon key + real logins only: exactly the surface the app has, so RLS and
 * every assert_role/assert_module gate is exercised rather than assumed.
 *
 * Beta has Machine & Workforce DISABLED, so the walk there stops at machine
 * assignment by design and asserts the module gate refuses instead.
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

const URL = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const FACTORY = (process.argv[2] ?? 'alpha').toLowerCase();
const NIL = '00000000-0000-0000-0000-000000000000';
const PHOTO = `${FACTORY}/walk/photo.jpg`;

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);

const T = {};
async function login(who) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${who}@${FACTORY}.test`, password: 'Password123!' }),
  });
  const j = await r.json().catch(() => null);
  return j?.access_token ? { token: j.access_token, userId: j.user?.id } : null;
}

async function get(who, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${T[who].token}` },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function rpc(who, name, args = {}) {
  const r = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${T[who].token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, body, msg: body?.message ?? '' };
}

async function insert(who, table, row) {
  const r = await fetch(`${URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${T[who].token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, body, msg: body?.message ?? '' };
}

/** Abort the walk with context — a broken precondition isn't a test failure. */
function bail(why) {
  console.log(`\n  STOPPED: ${why}`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  console.log(`\n  Full lifecycle walk — factory: ${FACTORY}\n`);

  for (const who of ['owner', 'order', 'qa', 'floor', 'store']) {
    T[who] = await login(who);
    if (!T[who]) bail(`could not sign in as ${who}@${FACTORY}.test`);
  }
  ok('signed in as order_taker, qa, floor_manager, store_manager, owner');

  // ---------------------------------------------------------------------------
  // 0. Regression guard: nothing is left stranded informed-but-unconfirmed.
  // ---------------------------------------------------------------------------
  console.log('\n  0. No job card is stranded in the old dead end');
  const allCards = await get('floor', 'job_cards?select=id,order_id,status,vendor_informed_at');
  const stranded = (allCards.body ?? []).filter((c) => c.vendor_informed_at && c.status !== 'confirmed');
  chk(stranded.length === 0, `0 job cards informed-but-unconfirmed (found ${stranded.length})`);

  // ---------------------------------------------------------------------------
  // 1. Order taker: create + submit
  // ---------------------------------------------------------------------------
  console.log('\n  1. Order taker — create and submit');
  let vendors = await get('order', 'vendors?select=id,name&deleted_at=is.null&limit=1');
  if (!vendors.body?.length) {
    // Beta ships with no client master. Creating one is itself part of the
    // supported flow (order_taker is a vendors writeRole), so seed and carry on
    // rather than skipping the whole walk for this factory.
    const made = await insert('order', 'vendors', { name: `Walk Client ${FACTORY}`, contact: '0000' });
    chk(made.ok, `no client master seeded — created one (${made.ok ? 'ok' : made.msg})`);
    vendors = await get('order', 'vendors?select=id,name&deleted_at=is.null&limit=1');
  }
  if (!vendors.body?.length) bail(`${FACTORY} has no vendors and one could not be created`);
  // Ordered by quantity, not `limit=1` off an unordered read. This walk needs
  // the SUFFICIENT-stock branch of submit_order, and an arbitrary colour is not
  // that: it picked up a 4-cone row left behind by another test suite, went to
  // awaiting_procurement, and stopped at step 1 reporting a pass. The colour
  // with the most stock is the one this walk has always meant.
  const stock = await get(
    'order',
    'thread_stock?select=color_code,quantity_meters&order=quantity_meters.desc&limit=1'
  );
  if (!stock.body?.length) bail(`${FACTORY} has no thread stock seeded`);
  const color = stock.body[0].color_code;
  info(`using ${color} (${Number(stock.body[0].quantity_meters).toLocaleString()} in stock)`);

  const created = await rpc('order', 'create_order', {
    p_vendor_id: vendors.body[0].id,
    p_sheets: [{ color_assignment: 'Walk test', repeats_count: 3, stitch_count: 1000, thread_color_codes: [color] }],
    p_cloth_photos: [PHOTO],
    p_design_sheet_url: null,
  });
  if (!created.ok) bail(`create_order refused: ${created.msg}`);
  const orderId = created.body.id;
  const orderCode = created.body.order_code;
  ok(`created ${orderCode}`);

  const submitted = await rpc('order', 'submit_order', { p_order_id: orderId });
  chk(submitted.ok, `submit_order → ${submitted.ok ? JSON.stringify(submitted.body?.status ?? submitted.body) : submitted.msg}`);

  let cur = (await get('order', `orders?id=eq.${orderId}&select=status`)).body?.[0]?.status;
  info(`order status: ${cur}`);
  if (cur === 'awaiting_procurement') {
    bail('submitted into awaiting_procurement (thread shortfall) — procurement is out of scope for this walk');
  }

  // ---------------------------------------------------------------------------
  // 2. QA: cloth inspection, then piece-by-piece repeat QA
  //
  // The sheet carries THREE pieces and the last one is REJECTED, not passed.
  // That rejection is what section 7 later looks for on the order taker's
  // Returns board — before 0054 it was invisible there, because the board was
  // built entirely on finishing-handoff history and a rejected piece never
  // gets a repeat, let alone a handoff. Two pieces still pass, which is what
  // the rest of the walk needs.
  // ---------------------------------------------------------------------------
  console.log('\n  2. QA — cloth inspection, piece-by-piece repeat QA, one REJECTION');
  const accepted = await rpc('qa', 'qa_accept_cloth', { p_order_id: orderId });
  chk(accepted.ok, `qa_accept_cloth → ${accepted.ok ? accepted.body?.status : accepted.msg}`);

  const sheets = await get('qa', `sheets?order_id=eq.${orderId}&select=id,repeats_count`);
  for (const s of sheets.body ?? []) {
    for (let i = 0; i < s.repeats_count - 1; i++) {
      const p = await rpc('qa', 'qa_pass_piece', { p_order_id: orderId, p_sheet_id: s.id, p_photo_url: PHOTO });
      if (!p.ok) no(`qa_pass_piece: ${p.msg}`);
    }
    const rejected = await rpc('qa', 'qa_reject_piece', {
      p_order_id: orderId,
      p_sheet_id: s.id,
      p_damage_type: 'fabric',
      p_photo_url: PHOTO,
      p_note: 'walk test — rejected at initial QA',
      p_scope: 'piece',
    });
    chk(rejected.ok && rejected.body?.count === 1,
      `qa_reject_piece (last piece on the sheet) → ${rejected.ok ? '1 damage record' : rejected.msg}`);
  }
  const completeQa = await rpc('qa', 'qa_complete_repeat_qa', { p_order_id: orderId });
  chk(completeQa.ok && completeQa.body?.status === 'awaiting_job_card',
    `qa_complete_repeat_qa → ${completeQa.ok ? completeQa.body?.status : completeQa.msg}`);

  // ---------------------------------------------------------------------------
  // 3. Floor manager: stage sequence, job card, CLIENT INFORMED, ASK FOR MATERIAL
  // ---------------------------------------------------------------------------
  console.log('\n  3. Floor manager — job card → client informed → ask for material');
  const seq = await rpc('floor', 'fm_set_stage_sequence', {
    p_order_id: orderId,
    p_stages: [
      { stage_type: 'embroidery', is_outsourced: false, sla_hours: 24, partner_id: null },
      { stage_type: 'press', is_outsourced: false, sla_hours: 12, partner_id: null },
    ],
  });
  chk(seq.ok, `fm_set_stage_sequence (2 stages) → ${seq.ok ? 'ok' : seq.msg}`);

  const design = await rpc('floor', 'fm_save_job_card_design', {
    p_order_id: orderId, p_design_code: 'WALK-01', p_stitches_per_repeat: 1000,
  });
  chk(design.ok, `fm_save_job_card_design → ${design.ok ? 'ok' : design.msg}`);

  const gen = await rpc('floor', 'fm_generate_job_card', { p_order_id: orderId });
  chk(gen.ok, `fm_generate_job_card → ${gen.ok ? 'ok' : gen.msg}`);

  let card = (await get('floor', `job_cards?order_id=eq.${orderId}&select=id,status,vendor_informed_at`)).body?.[0];
  chk(card?.status === 'draft', `job card starts at 'draft' (is '${card?.status}')`);

  // ---------------------------------------------------------------------------
  // 3b. Needle lines are added ONE AT A TIME and never develop a gap (0053).
  //
  // The Review screen no longer offers a 1..6 picker per line — the needle
  // number is positional and assigned here, so this is what proves the screen's
  // "+ Add needle" behaves: append gets the next number, the 6-needle cap
  // holds, and deleting a middle line renumbers the rest rather than leaving
  // "Needle 1, Needle 3".
  // ---------------------------------------------------------------------------
  console.log('\n  3b. Needle lines — add one at a time, capped at 6, no gaps');
  const needles = async () =>
    ((await get('floor', `job_card_lines?job_card_id=eq.${card.id}&select=id,needle_number,thread_color_code&order=needle_number`)).body ?? []);

  let lines = await needles();
  const startCount = lines.length;
  info(`generated ${startCount} line(s): ${lines.map((l) => l.needle_number + ':' + l.thread_color_code).join(', ')}`);

  const added = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: card.id, p_thread_color_code: 'WALK-ADD',
  });
  chk(added.ok && added.body?.needle_number === startCount + 1,
    `+ Add needle assigns the NEXT number, not a picked one → Needle ${added.body?.needle_number ?? added.msg}`);

  const blank = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: card.id, p_thread_color_code: '   ',
  });
  chk(!blank.ok && /thread colour is required/i.test(blank.msg),
    `a blank thread colour is refused: "${blank.msg.slice(0, 50)}"`);

  // Fill to exactly 6, then prove the 7th is refused.
  lines = await needles();
  for (let n = lines.length; n < 6; n++) {
    const fill = await rpc('floor', 'fm_add_job_card_line', {
      p_job_card_id: card.id, p_thread_color_code: `WALK-F${n}`,
    });
    if (!fill.ok) no(`filling to 6 needles: ${fill.msg}`);
  }
  lines = await needles();
  chk(lines.length === 6, `filled to the cap → ${lines.length} lines`);

  const overCap = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: card.id, p_thread_color_code: 'WALK-7TH',
  });
  chk(!overCap.ok && /capped at 6/i.test(overCap.msg),
    `a 7th needle is refused: "${overCap.msg.slice(0, 50)}"`);

  // Delete from the MIDDLE — the case that used to leave a hole.
  const middle = lines[2];
  const dropped = await rpc('floor', 'fm_delete_job_card_line', {
    p_job_card_id: card.id, p_line_id: middle.id,
  });
  chk(dropped.ok, `deleted the middle line (was Needle ${middle.needle_number}) → ${dropped.ok ? 'ok' : dropped.msg}`);

  lines = await needles();
  chk(lines.length === 5 && lines.every((l, i) => l.needle_number === i + 1),
    `remaining lines renumbered 1..${lines.length} with no gap → [${lines.map((l) => l.needle_number).join(',')}]`);

  // With a slot free again, the cap lets exactly one more back in.
  const readd = await rpc('floor', 'fm_add_job_card_line', {
    p_job_card_id: card.id, p_thread_color_code: 'WALK-BACK',
  });
  chk(readd.ok && readd.body?.needle_number === 6,
    `deleting frees a slot — next add is Needle ${readd.body?.needle_number ?? readd.msg}`);

  // Tidy back down to the generated set so the rest of the walk is unaffected.
  for (const extra of (await needles()).filter((l) => /^WALK-/.test(l.thread_color_code))) {
    await rpc('floor', 'fm_delete_job_card_line', { p_job_card_id: card.id, p_line_id: extra.id });
  }
  lines = await needles();
  chk(lines.length === startCount && lines.every((l, i) => l.needle_number === i + 1),
    `cleaned back to ${lines.length} sequential line(s)`);

  // THE FIX: ask-for-material must be refused while draft, then allowed the
  // moment Client informed is pressed — no other step in between.
  const askTooEarly = await rpc('floor', 'fm_ask_for_material', { p_order_id: orderId });
  chk(!askTooEarly.ok && /must be confirmed/i.test(askTooEarly.msg),
    `ask for material refused while draft: "${askTooEarly.msg.slice(0, 60)}"`);

  const informed = await rpc('floor', 'fm_mark_vendor_informed', { p_order_id: orderId });
  chk(informed.ok, `fm_mark_vendor_informed → ${informed.ok ? 'ok' : informed.msg}`);
  chk(informed.body?.status === 'confirmed', `  CLIENT INFORMED CONFIRMED THE CARD (draft → ${informed.body?.status})`);

  cur = (await get('floor', `orders?id=eq.${orderId}&select=status`)).body?.[0]?.status;
  chk(cur === 'job_card_confirmed', `  order advanced to job_card_confirmed (is ${cur})`);

  const readyReps = await get('floor', `repeats?select=current_status,sheets!inner(order_id)&sheets.order_id=eq.${orderId}`);
  const allReady = (readyReps.body ?? []).every((r) => r.current_status === 'ready_for_production');
  chk(allReady && readyReps.body.length > 0,
    `  all ${readyReps.body?.length ?? 0} repeats moved to ready_for_production`);

  const asked = await rpc('floor', 'fm_ask_for_material', { p_order_id: orderId });
  chk(asked.ok, `ASK FOR MATERIAL immediately after, no extra step → ${asked.ok ? 'ok' : asked.msg}`);

  // ---------------------------------------------------------------------------
  // 4. Store manager issues, floor manager accepts
  // ---------------------------------------------------------------------------
  console.log('\n  4. Store manager issues material → floor manager accepts');
  const queue = await rpc('store', 'material_issue_queue');
  const mine = (queue.body ?? []).find((r) => r.order_id === orderId);
  chk(!!mine, `${orderCode} appears in the store manager's queue`);

  if (mine) {
    const issued = await rpc('store', 'sm_issue_materials', { p_job_card_id: mine.job_card_id, p_note: 'walk test' });
    chk(issued.ok, `sm_issue_materials → ${issued.ok ? `${issued.body?.lines} line(s)` : issued.msg}`);

    const fmQueue = await rpc('floor', 'fm_material_issue_queue');
    const pendingRow = (fmQueue.body ?? []).find((r) => r.order_id === orderId);
    chk(!!pendingRow, `  appears in the floor manager's Accept inventory tab`);

    if (pendingRow) {
      const acc = await rpc('floor', 'fm_accept_inventory', {
        p_material_issue_id: pendingRow.material_issue_id, p_photo_url: PHOTO,
      });
      chk(acc.ok, `fm_accept_inventory (photo required) → ${acc.ok ? 'ok' : acc.msg}`);
      cur = (await get('floor', `orders?id=eq.${orderId}&select=status`)).body?.[0]?.status;
      chk(cur === 'machine_selection_pending', `  order → machine_selection_pending (is ${cur})`);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Assign machine → start production
  // ---------------------------------------------------------------------------
  console.log('\n  5. Assign machine → START PRODUCTION');
  const machines = await get('floor', 'machines?select=id,name,managed_by&deleted_at=is.null');
  let shifts = await get('floor', 'shifts?select=machine_id&status=eq.open');
  let openIds = new Set((shifts.body ?? []).map((s) => s.machine_id));
  // Both fm_open_shift and fm_assign_machine refuse a floor manager any machine
  // whose managed_by isn't their own uid — an unmanaged (null) machine is NOT
  // usable here, even though fm_shifts_for_date happily lists it.
  const myMachines = (machines.body ?? []).filter((m) => m.managed_by === T.floor.userId);
  let usable = myMachines.find((m) => openIds.has(m.id));

  if (!usable && myMachines.length) {
    // No open shift — `verify:tenancy` closes M-01's as part of its own run, so
    // this walk cannot assume one is left over. Opening a shift is a legitimate
    // floor-manager step (Stage 7) that precedes assignment anyway.
    const workers = await get('floor', 'profiles?select=id,display_name&role=eq.worker&is_active=is.true&limit=1');
    const worker = workers.body?.[0];
    if (worker) {
      const opened = await rpc('floor', 'fm_open_shift', {
        p_machine_id: myMachines[0].id,
        p_worker_id: worker.id,
        p_order_id: null,
        p_open_photo_url: PHOTO,
        p_open_stitches: 0,
        p_worker_photo_url: PHOTO,
      });
      chk(opened.ok, `no open shift — opened one on ${myMachines[0].name} → ${opened.ok ? 'ok' : opened.msg}`);
      if (opened.ok) {
        shifts = await get('floor', 'shifts?select=machine_id&status=eq.open');
        openIds = new Set((shifts.body ?? []).map((s) => s.machine_id));
        usable = myMachines.find((m) => openIds.has(m.id));
      }
    }
  }

  if (!usable) {
    // Beta has machine_workforce disabled; assert the module gate instead.
    const refused = await rpc('floor', 'fm_assign_machine', { p_order_id: orderId, p_machine_id: NIL });
    if (/not available for your factory/i.test(refused.msg)) {
      ok(`machine assignment correctly gated off: "${refused.msg}"`);
      bail('Machine & Workforce is disabled for this factory — production stages are out of scope here');
    }
    bail('no machine with an open shift is available to this floor manager — open a shift first');
  }

  const assign = await rpc('floor', 'fm_assign_machine', { p_order_id: orderId, p_machine_id: usable.id });
  chk(assign.ok, `fm_assign_machine (${usable.name}) → ${assign.ok ? 'ok' : assign.msg}`);
  chk(assign.body?.assigned_machine_id === usable.id, `  machine recorded on the order`);
  chk(assign.body?.status === 'machine_selection_pending',
    `  order still machine_selection_pending — Start Production is the next required press`);

  const start = await rpc('floor', 'fm_start_production', { p_order_id: orderId });
  chk(start.ok, `fm_start_production → ${start.ok ? `${start.body?.repeats_advanced} repeat(s) advanced` : start.msg}`);
  chk(start.body?.status === 'in_production', `  order → in_production`);

  // ---------------------------------------------------------------------------
  // 6. The stage loop, with the QA boundary tested from real sessions
  // ---------------------------------------------------------------------------
  console.log('\n  6. Stage loop — FM starts/sends, QA passes (boundary from real logins)');
  const stages = (await get('floor', `order_stages?order_id=eq.${orderId}&select=id,sequence,stage_type&order=sequence`)).body ?? [];
  const walkReps = (await get('floor',
    `repeats?select=id,repeat_code,current_status,sheets!inner(order_id)&sheets.order_id=eq.${orderId}`)).body ?? [];
  const rep = walkReps[0];
  if (!rep) bail('no repeat to walk through the stage loop');
  info(`walking ${rep.repeat_code} through ${stages.length} stage(s)`);

  // QA must be able to reach this order at all — its own queue screen.
  const qaVisible = await get('qa', `orders?id=eq.${orderId}&select=status`);
  chk(qaVisible.body?.[0]?.status === 'in_production', `QA can see ${orderCode} in production`);

  for (const st of stages) {
    const startStage = await rpc('floor', 'fm_start_stage', { p_repeat_id: rep.id });
    chk(startStage.ok, `[${st.stage_type}] fm_start_stage (FM) → ${startStage.ok ? 'in_progress' : startStage.msg}`);

    const toQa = await rpc('floor', 'fm_send_to_stage_qa', { p_repeat_id: rep.id });
    chk(toQa.ok, `[${st.stage_type}] fm_send_to_stage_qa (FM) → ${toQa.ok ? 'stage_qa' : toQa.msg}`);

    // FIX 3 — the boundary, on a REAL repeat sitting at stage_qa, not a nil id.
    const fmTries = await rpc('floor', 'qa_pass_stage_qa', { p_repeat_id: rep.id });
    chk(fmTries.status === 403 && /not permitted/i.test(fmTries.msg),
      `[${st.stage_type}] floor_manager REFUSED Pass QA on a live stage_qa repeat (${fmTries.status})`);

    const fmDamage = await rpc('floor', 'mark_stage_damage', { p_repeat_id: rep.id, p_damage_type: 'other' });
    chk(fmDamage.status === 403 && /not permitted/i.test(fmDamage.msg),
      `[${st.stage_type}] floor_manager REFUSED Mark damage on the same repeat (${fmDamage.status})`);

    const qaPasses = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: rep.id });
    chk(qaPasses.ok, `[${st.stage_type}] QA PASSED it → ${qaPasses.ok ? qaPasses.body?.current_status : qaPasses.msg}`);

    const isLast = st.sequence === stages.length;
    if (isLast) {
      chk(qaPasses.body?.current_status === 'awaiting_final_qa',
        `  last stage → awaiting_final_qa (drives the "ready for final QA" guidance)`);
    } else {
      chk(qaPasses.body?.current_status === 'awaiting_stage',
        `  advanced to the next stage (awaiting_stage)`);
    }
  }

  // QA's other action is reachable too — checked on a second repeat so the one
  // above stays clean at awaiting_final_qa.
  const spare = walkReps[1];
  if (spare) {
    const qaDamage = await rpc('qa', 'mark_stage_damage', {
      p_repeat_id: spare.id, p_damage_type: 'other', p_photo_url: PHOTO, p_note: 'walk test',
    });
    chk(qaDamage.ok, `QA can Mark damage on ${spare.repeat_code} → ${qaDamage.ok ? 'damage recorded' : qaDamage.msg}`);
  }

  // Mirror boundary: QA must NOT hold the floor manager's two actions.
  const qaStart = await rpc('qa', 'fm_start_stage', { p_repeat_id: rep.id });
  chk(qaStart.status === 403, `qa REFUSED fm_start_stage — the mirror boundary holds (${qaStart.status})`);

  // ---------------------------------------------------------------------------
  // 7. The Initial-QA rejection reaches the order taker's Returns board (0054)
  //
  // This is the whole point of section 2's rejection. Before 0054 the board was
  // built only on finishing-handoff history, so a piece rejected at Stage 2 —
  // which never gets a repeat, let alone a handoff — could not appear at all,
  // and Active returns sat at (0) while the piece waited to go back.
  // ---------------------------------------------------------------------------
  console.log('\n  7. Order taker Returns — the Initial-QA rejection shows in Active returns');
  const board = async (who = 'order') => ((await rpc(who, 'ot_return_repeats')).body ?? []);

  let rows = await board();
  const mineRows = rows.filter((r) => r.order_id === orderId);
  const rejection = mineRows.find((r) => r.kind === 'qa_rejection');

  chk(!!rejection, `the rejected piece appears on the board at all (${mineRows.length} row(s) for ${orderCode})`);

  if (rejection) {
    chk(rejection.bucket === 'active', `  it lands in ACTIVE returns (bucket=${rejection.bucket})`);
    chk(!!rejection.order_code, `  Order: ${rejection.order_code}`);
    chk(rejection.reason === 'fabric', `  Reason: ${rejection.reason}`);
    chk(rejection.photo_url === PHOTO, `  Photo: ${rejection.photo_url ? 'carried through' : 'MISSING'}`);
    chk(!!rejection.piece_index && !!rejection.piece_total,
      `  numbered as the QA screen showed it: piece ${rejection.piece_index} of ${rejection.piece_total}`);
    // The sheet's repeats are coded in one statement and share a created_at, so
    // ordering on that alone gave an arbitrary piece number (0055).
    const reread = (await board()).find((r) => r.entry_id === rejection.entry_id);
    chk(reread?.piece_index === rejection.piece_index,
      `  and that number is stable across reads (${reread?.piece_index})`);
    chk(rejection.damage_id === rejection.entry_id,
      `  carries the damage id "Complete return" needs`);

    // Role boundary: this board and its completion belong to the order taker.
    const qaBoard = await rpc('qa', 'ot_return_repeats');
    chk(qaBoard.status >= 400, `  QA is refused on the returns board (${qaBoard.status})`);
    const qaComplete = await rpc('qa', 'ot_complete_qa_return', { p_damage_id: rejection.damage_id });
    chk(qaComplete.status >= 400, `  QA is refused on Complete return (${qaComplete.status})`);

    // The press itself.
    const done = await rpc('order', 'ot_complete_qa_return', { p_damage_id: rejection.damage_id });
    chk(done.ok && !!done.body?.ot_return_confirmed_at,
      `COMPLETE RETURN → ${done.ok ? 'confirmed ' + done.body.ot_return_confirmed_at : done.msg}`);

    rows = await board();
    const moved = rows.find((r) => r.entry_id === rejection.entry_id);
    chk(moved?.bucket === 'completed',
      `  it moved Active → COMPLETED returns (bucket=${moved?.bucket})`);
    chk(!rows.some((r) => r.entry_id === rejection.entry_id && r.bucket === 'active'),
      `  and is no longer in Active returns`);

    // One-shot, same as the finishing-side completion (0036).
    const twice = await rpc('order', 'ot_complete_qa_return', { p_damage_id: rejection.damage_id });
    chk(!twice.ok, `  a second Complete return on the same piece is refused: "${twice.msg.slice(0, 45)}"`);
  }

  // The finishing side of the board must still work exactly as before — this
  // union must not have swallowed the rows 0032/0036 already returned.
  const finishingRows = (await board()).filter((r) => r.kind === 'finishing');
  chk(finishingRows.every((r) => !!r.repeat_id && !!r.repeat_code),
    `finishing rows are unchanged and still carry a repeat (${finishingRows.length} row(s))`);

  console.log(`\n  Walked ${orderCode} end to end.`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
