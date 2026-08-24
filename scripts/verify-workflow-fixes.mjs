/**
 * The seven workflow fixes (0084), driven end to end against the live database.
 *
 *   node scripts/verify-workflow-fixes.mjs [alpha|beta]
 *
 * This creates a REAL order and walks it the whole way — order taker → QA →
 * floor manager → store manager → floor manager → QA → delivery person →
 * finishing partner → delivery person → floor manager → QA → Final QA — signing
 * in as the role that actually performs each step. Anon key and real logins
 * only, so every RLS policy and every assert_role/assert_module gate is
 * exercised rather than assumed.
 *
 * The order carries TWO stages (embroidery → clipping), because the point of
 * Fixes 4-6 is what happens BETWEEN two stages. A one-stage order would pass
 * every individual call and prove nothing about the cycle.
 *
 * WHAT EACH FIX IS PROVEN BY, and not merely that its RPC exists:
 *
 *   1  Accept inventory  the lines are listed; a partial tick is REFUSED; a
 *                        missing photo is REFUSED; a full tick advances the
 *                        order to machine_selection_pending.
 *   2  Assign machine    the machine used has NO open shift, and production
 *                        starts anyway. The old combined RPC is gone.
 *   3  Stage QA photo    a passless pass is REFUSED; a photographed one lands
 *                        on handover_for_delivery mid-sequence and on
 *                        awaiting_final_qa at the last stage.
 *   4  Handover          a partner who does not do the destination stage is
 *                        REFUSED; a good pair records both on the repeat.
 *   5  Three tabs        the row reports tab=collection, then delivery, then
 *                        pickup, in that order, as each leg completes; every
 *                        leg's photo is required by the database.
 *   6  Return QA         collection lands the piece on stage_qa for the NEW
 *                        stage, not in_progress.
 *   7  Journey           the summary carries every stage, both actors' names,
 *                        the partner, and the photos.
 *
 * Beta has Machine & Workforce DISABLED, so the run there stops at machine
 * assignment by design and asserts the module gate refuses instead.
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
const FACTORY = (process.argv[2] ?? 'alpha').toLowerCase();
const PHOTO = `${FACTORY}/wf/photo.jpg`;

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);
const head = (m) => console.log('\n' + m);

const T = {};
async function login(who) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${who}@${FACTORY}.test`, password: 'Password123!' }),
  });
  const j = await r.json().catch(() => null);
  if (!j?.access_token) throw new Error(`login failed for ${who}@${FACTORY}.test`);
  return { token: j.access_token, userId: j.user?.id };
}

async function rpc(who, fn, args) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${T[who].token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body, msg: body?.message ?? body?.hint ?? `HTTP ${r.status}` };
}

async function get(who, path) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${T[who].token}` },
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

const bail = (m) => { console.log(`\n  STOP  ${m}\n`); report(); process.exit(fail ? 1 : 0); };
function report() {
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
}

// ---------------------------------------------------------------------------

console.log(`\n  Workflow fixes (0084) — factory: ${FACTORY}\n`);

for (const who of ['order', 'qa', 'floor', 'store', 'delivery', 'partner', 'owner']) {
  T[who] = await login(who);
}
ok('signed in as order_taker, qa, floor_manager, store_manager, delivery, finishing_partner, owner');

// The destination stage must be one a seeded finishing partner actually
// handles, because Fix 4 refuses a mismatch — that refusal is the point.
const partners = await get('floor', 'finishing_partners?select=id,name,stage_type&deleted_at=is.null');
const PARTNER = (partners.body ?? [])[0];
if (!PARTNER) bail('no finishing partner on file — Fix 4 needs one to hand over to');
const STAGE2 = PARTNER.stage_type;
const STAGE1 = STAGE2 === 'embroidery' ? 'press' : 'embroidery';
info(`stages: ${STAGE1} → ${STAGE2}   (partner "${PARTNER.name}" handles ${STAGE2})`);

// ---------------------------------------------------------------------------
head('  1. Order taker — create and submit (2 pieces, 1 sheet)');
// ---------------------------------------------------------------------------
const vendors = await get('order', 'vendors?select=id&deleted_at=is.null&limit=1');
if (!vendors.body?.length) bail('no vendor on file');

const stock = await get('order', 'inventory_items?select=color_code,quantity&item_type=eq.thread&order=quantity.desc&limit=1');
const COLOR = stock.body?.[0]?.color_code;
if (!COLOR) bail('no thread stock on file');
info(`using ${COLOR} (${Number(stock.body[0].quantity).toLocaleString()} in stock)`);

const created = await rpc('order', 'create_order', {
  p_vendor_id: vendors.body[0].id,
  p_sheets: [{ color_assignment: 'WF fixes', repeats_count: 2, stitch_count: 1000, thread_color_codes: [COLOR] }],
  p_cloth_photos: [PHOTO],
  p_design_sheet_url: null,
});
if (!created.ok) bail(`create_order refused: ${created.msg}`);
const ORDER = created.body.id;
const CODE = created.body.order_code;
ok(`created ${CODE}`);

const submitted = await rpc('order', 'submit_order', { p_order_id: ORDER });
chk(submitted.ok, `submit_order → ${submitted.ok ? 'ok' : submitted.msg}`);
let cur = (await get('order', `orders?id=eq.${ORDER}&select=status`)).body?.[0]?.status;
if (cur === 'awaiting_procurement') bail('submitted into a thread shortfall — procurement is out of scope here');

// ---------------------------------------------------------------------------
head('  2. QA — cloth inspection and repeat coding (all pieces pass)');
// ---------------------------------------------------------------------------
chk((await rpc('qa', 'qa_accept_cloth', { p_order_id: ORDER })).ok, 'qa_accept_cloth → awaiting_coding');

const sheets = await get('qa', `sheets?order_id=eq.${ORDER}&select=id,repeats_count`);
for (const s of sheets.body ?? []) {
  for (let i = 0; i < s.repeats_count; i++) {
    const p = await rpc('qa', 'qa_pass_piece', { p_order_id: ORDER, p_sheet_id: s.id, p_photo_url: PHOTO });
    if (!p.ok) no(`qa_pass_piece: ${p.msg}`);
  }
}
const doneQa = await rpc('qa', 'qa_complete_repeat_qa', { p_order_id: ORDER });
chk(doneQa.ok && doneQa.body?.status === 'awaiting_job_card',
  `qa_complete_repeat_qa → ${doneQa.ok ? doneQa.body?.status : doneQa.msg}`);

// ---------------------------------------------------------------------------
head('  3. Floor manager — two-stage sequence, job card, client informed');
// ---------------------------------------------------------------------------
const seq = await rpc('floor', 'fm_set_stage_sequence', {
  p_order_id: ORDER,
  p_stages: [
    { stage_type: STAGE1, is_outsourced: false, sla_hours: 24, partner_id: null },
    { stage_type: STAGE2, is_outsourced: true, sla_hours: 24, partner_id: null },
  ],
});
chk(seq.ok, `fm_set_stage_sequence (${STAGE1} → ${STAGE2}) → ${seq.ok ? 'ok' : seq.msg}`);

chk((await rpc('floor', 'fm_save_job_card_design', {
  p_order_id: ORDER, p_design_code: 'WF-01', p_stitches_per_repeat: 1000,
})).ok, 'fm_save_job_card_design → ok');
chk((await rpc('floor', 'fm_generate_job_card', { p_order_id: ORDER })).ok, 'fm_generate_job_card → ok');

const informed = await rpc('floor', 'fm_mark_vendor_informed', { p_order_id: ORDER });
chk(informed.ok && informed.body?.status === 'confirmed',
  `fm_mark_vendor_informed → ${informed.ok ? informed.body?.status : informed.msg}`);
chk((await rpc('floor', 'fm_ask_for_material', { p_order_id: ORDER })).ok, 'fm_ask_for_material → ok');

// ===========================================================================
head('  FIX 1 — Accept inventory is itemised, and every line must be ticked');
// ===========================================================================
const smQueue = await rpc('store', 'material_issue_queue');
const mine = (smQueue.body ?? []).find((r) => r.order_id === ORDER);
if (!mine) bail(`${CODE} never reached the store manager's queue`);
const issued = await rpc('store', 'sm_issue_materials', { p_job_card_id: mine.job_card_id, p_note: 'wf fixes' });
chk(issued.ok, `sm_issue_materials → ${issued.ok ? `${issued.body?.lines} line(s)` : issued.msg}`);

const fmQueue = await rpc('floor', 'fm_material_issue_queue');
const pending = (fmQueue.body ?? []).find((r) => r.order_id === ORDER);
if (!pending) bail('the issue never reached the Accept inventory tab');
const ISSUE = pending.material_issue_id;

const linesRes = await rpc('floor', 'fm_material_issue_lines', { p_material_issue_id: ISSUE });
chk(linesRes.ok, `fm_material_issue_lines → ${linesRes.ok ? 'ok' : linesRes.msg}`);
const LINES = linesRes.body ?? [];
chk(LINES.length > 0, `  the issue itemises ${LINES.length} line(s), not one blanket total`);
chk(LINES.every((l) => l.color_code && l.item_type && l.unit && l.issued_meters != null),
  '  every line carries item, type, unit and quantity');
info(LINES.map((l) => `${l.color_code} (${l.item_type}) ${l.issued_meters}${l.unit}`).join(', '));
chk(LINES.every((l) => l.received_at === null), '  no line is ticked yet');

// The old blanket 2-argument call must be gone, not merely unused.
const blanket = await rpc('floor', 'fm_accept_inventory', {
  p_material_issue_id: ISSUE, p_photo_url: PHOTO,
});
chk(!blanket.ok && /schema cache|function/i.test(blanket.msg),
  `  the blanket 2-arg accept is GONE: "${blanket.msg.slice(0, 60)}"`);

const noPhoto = await rpc('floor', 'fm_accept_inventory', {
  p_material_issue_id: ISSUE, p_photo_url: '  ', p_received_item_ids: LINES.map((l) => l.item_id),
});
chk(!noPhoto.ok && /photo/i.test(noPhoto.msg), `  a missing photo is refused: "${noPhoto.msg.slice(0, 55)}"`);

const noneTicked = await rpc('floor', 'fm_accept_inventory', {
  p_material_issue_id: ISSUE, p_photo_url: PHOTO, p_received_item_ids: [],
});
chk(!noneTicked.ok && /every line/i.test(noneTicked.msg),
  `  zero lines ticked is refused: "${noneTicked.msg.slice(0, 55)}"`);

if (LINES.length > 1) {
  const partial = await rpc('floor', 'fm_accept_inventory', {
    p_material_issue_id: ISSUE, p_photo_url: PHOTO,
    p_received_item_ids: LINES.slice(0, LINES.length - 1).map((l) => l.item_id),
  });
  chk(!partial.ok && /every line/i.test(partial.msg),
    `  a PARTIAL tick is refused: "${partial.msg.slice(0, 55)}"`);
} else {
  info('only one line on this issue — the partial-tick case needs two, covered by the zero case above');
}

const alien = await rpc('floor', 'fm_accept_inventory', {
  p_material_issue_id: ISSUE, p_photo_url: PHOTO,
  p_received_item_ids: ['00000000-0000-0000-0000-000000000000'],
});
chk(!alien.ok, `  an id from another issue is refused: "${alien.msg.slice(0, 55)}"`);

const accepted = await rpc('floor', 'fm_accept_inventory', {
  p_material_issue_id: ISSUE, p_photo_url: PHOTO, p_received_item_ids: LINES.map((l) => l.item_id),
});
chk(accepted.ok, `  every line ticked → accepted (${accepted.ok ? 'ok' : accepted.msg})`);

const after = await rpc('floor', 'fm_material_issue_lines', { p_material_issue_id: ISSUE });
chk((after.body ?? []).every((l) => l.received_at !== null),
  '  each line records WHEN it was received, not just the issue as a whole');

cur = (await get('floor', `orders?id=eq.${ORDER}&select=status`)).body?.[0]?.status;
chk(cur === 'machine_selection_pending', `  order → machine_selection_pending (is ${cur})`);

// ===========================================================================
head('  FIX 2 — Assign a machine with no shift, then start production');
// ===========================================================================
const machines = await get('floor', 'machines?select=id,name,managed_by&deleted_at=is.null');
const myMachines = (machines.body ?? []).filter((m) => m.managed_by === T.floor.userId);

if (!myMachines.length) {
  const refused = await rpc('floor', 'fm_assign_machine', { p_order_id: ORDER, p_machine_id: '00000000-0000-0000-0000-000000000000' });
  if (/not available for your factory/i.test(refused.msg)) {
    ok(`machine assignment correctly gated off: "${refused.msg}"`);
    bail('Machine & Workforce is disabled for this factory — the stage loop is out of scope here');
  }
  bail('this floor manager manages no machine');
}

// A machine with NO open shift is the whole point: before 0084 both assignment
// and Start Production refused one.
const openShifts = await get('floor', 'shifts?select=machine_id&status=eq.open');
const openIds = new Set((openShifts.body ?? []).map((s) => s.machine_id));
const shiftless = myMachines.find((m) => !openIds.has(m.id));
const MACHINE = shiftless ?? myMachines[0];
chk(!!shiftless, shiftless
  ? `using ${MACHINE.name}, which has NO open shift`
  : `every machine this FM manages has an open shift — the no-shift case cannot be proven on this data`);

// The combined assign-and-open-a-shift RPC must be gone, not merely unused.
const combined = await rpc('floor', 'fm_assign_machine_with_shift', {
  p_order_id: ORDER, p_machine_id: MACHINE.id, p_worker_id: null, p_worker_photo_url: PHOTO,
});
chk(!combined.ok && /schema cache|function/i.test(combined.msg),
  `fm_assign_machine_with_shift is GONE: "${combined.msg.slice(0, 60)}"`);

const assign = await rpc('floor', 'fm_assign_machine', { p_order_id: ORDER, p_machine_id: MACHINE.id });
chk(assign.ok, `fm_assign_machine — no worker, no photo, no shift → ${assign.ok ? 'ok' : assign.msg}`);
chk(assign.body?.assigned_machine_id === MACHINE.id, '  machine recorded on the order');

const start = await rpc('floor', 'fm_start_production', { p_order_id: ORDER });
chk(start.ok, `fm_start_production immediately after → ${start.ok ? `${start.body?.repeats_advanced} repeat(s) advanced` : start.msg}`);
chk(start.body?.status === 'in_production', '  order → in_production');
chk(start.body?.repeats_total === 2, `  0061's repeats_total is still reported (${start.body?.repeats_total})`);

// The Shift Close system is untouched: its own queue still answers.
const shiftQueue = await rpc('floor', 'fm_shift_close_queue');
chk(shiftQueue.status !== 404, `Shift Close queue still exists and answers (HTTP ${shiftQueue.status})`);

// ---------------------------------------------------------------------------
const stages = (await get('floor', `order_stages?order_id=eq.${ORDER}&select=id,sequence,stage_type&order=sequence`)).body ?? [];
chk(stages.length === 2, `order has ${stages.length} stages`);
const reps = (await get('floor',
  `repeats?select=id,repeat_code,current_status,current_stage_index,sheets!inner(order_id)&sheets.order_id=eq.${ORDER}&order=repeat_code`)).body ?? [];
const REP = reps[0];
if (!REP) bail('no repeat to walk');
info(`walking ${REP.repeat_code} through both stages`);

const repeatNow = async () =>
  (await get('floor', `repeats?id=eq.${REP.id}&select=current_status,current_stage_index,current_partner_id,current_delivery_id`)).body?.[0];

// ===========================================================================
head(`  FIX 3 — Stage QA needs a photo (stage 1: ${STAGE1})`);
// ===========================================================================
let st = await repeatNow();
chk(st.current_status === 'in_progress' && st.current_stage_index === 1,
  `stage 1 opened at in_progress (is ${st.current_status}, index ${st.current_stage_index})`);

chk((await rpc('floor', 'fm_send_to_stage_qa', { p_repeat_id: REP.id })).ok, 'FM sends it to Stage QA');

const fmPass = await rpc('floor', 'qa_pass_stage_qa', { p_repeat_id: REP.id, p_photo_url: PHOTO });
chk(fmPass.status === 403, `floor_manager is still REFUSED Pass QA — the QA boundary holds (${fmPass.status})`);

const passless = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: REP.id, p_photo_url: '' });
chk(!passless.ok && /photo/i.test(passless.msg),
  `a passless Pass QA is REFUSED: "${passless.msg.slice(0, 55)}"`);

const oldArity = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: REP.id });
chk(!oldArity.ok, '  the photoless 1-arg signature is gone');

const passed = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: REP.id, p_photo_url: PHOTO });
chk(passed.ok && passed.body?.current_status === 'handover_for_delivery',
  `QA passes WITH a photo → ${passed.ok ? passed.body?.current_status : passed.msg}`);

// ===========================================================================
head(`  FIX 4 — Handover names the destination, the courier and the handler`);
// ===========================================================================
const people = await rpc('floor', 'fm_delivery_people');
chk(people.ok && (people.body ?? []).length > 0,
  `fm_delivery_people → ${people.ok ? `${people.body.length} delivery person(s)` : people.msg}`);
const DP = (people.body ?? []).find((p) => p.id === T.delivery.userId) ?? (people.body ?? [])[0];
chk(!!DP, '  the seeded delivery login appears in the picker');

const bareHandover = await rpc('floor', 'fm_hand_over_stage', { p_repeat_id: REP.id });
chk(!bareHandover.ok, 'the bare 1-arg "Hand over" is gone — a courier must be named');

const badPerson = await rpc('floor', 'fm_hand_over_stage', {
  p_repeat_id: REP.id, p_delivery_id: T.qa.userId, p_partner_id: PARTNER.id,
});
chk(!badPerson.ok, `a non-delivery user is refused as courier: "${badPerson.msg.slice(0, 50)}"`);

// The partner must handle the DESTINATION stage. Only checkable when the
// factory has a partner whose stage_type differs from stage 2.
const others = (partners.body ?? []).filter((p) => p.stage_type !== STAGE2);
if (others.length) {
  const wrong = await rpc('floor', 'fm_hand_over_stage', {
    p_repeat_id: REP.id, p_delivery_id: DP.id, p_partner_id: others[0].id,
  });
  chk(!wrong.ok && /does not handle/i.test(wrong.msg),
    `a partner who does not do ${STAGE2} is refused: "${wrong.msg.slice(0, 55)}"`);
} else {
  info(`only ${STAGE2} partners on file — the wrong-stage refusal needs a second stage_type to prove`);
}

const handed = await rpc('floor', 'fm_hand_over_stage', {
  p_repeat_id: REP.id, p_delivery_id: DP.id, p_partner_id: PARTNER.id,
});
// 0092 folded the collection into this press: the handover IS the collection.
chk(handed.ok && handed.body?.current_status === 'handed_over',
  `"Handover to ${STAGE2}" → ${handed.ok ? handed.body?.current_status : handed.msg}`);
st = await repeatNow();
chk(st.current_delivery_id === DP.id, '  the chosen delivery person is recorded on the repeat');
chk(st.current_partner_id === PARTNER.id, '  the chosen finishing partner is recorded on the repeat');

// ===========================================================================
head('  FIX 5 (as amended by 0092) — Delivery → Pickup → Delivery, a photo at every leg');
// ===========================================================================
const dpRow = async () => {
  const q = await rpc('delivery', 'dp_orders_queue');
  if (!q.ok) { no(`dp_orders_queue → ${q.msg}`); return null; }
  return (q.body ?? []).find((r) => r.repeat_id === REP.id) ?? null;
};

let row = await dpRow();
chk(!!row, `${REP.repeat_code} is in the delivery person's queue`);
chk(row?.tab === 'delivery', `  tab = delivery, straight away (is ${row?.tab})`);
chk(row?.destination_kind === 'partner', `  bound for the partner (is ${row?.destination_kind})`);
chk(row?.current_delivery_id === T.delivery.userId, '  the queue row is scoped to this delivery person');
chk(row?.partner_name === PARTNER.name, `  it already knows its destination partner (${row?.partner_name})`);
chk(row?.destination_stage === STAGE2, `  and the stage it is going FOR (${row?.destination_stage})`);

// The Collection tab and its RPC are gone: the FM's handover was the only
// thing that ever produced the state they existed to clear.
const collectGone = await rpc('delivery', 'dp_collect_from_floor', { p_repeat_id: REP.id, p_photo_url: PHOTO });
chk(!collectGone.ok && /schema cache|function/i.test(collectGone.msg),
  '  dp_collect_from_floor is GONE — the handover is the collection now');

// The delivery person no longer picks the partner — that RPC is gone.
const oldSend = await rpc('delivery', 'dp_send_to_partner', { p_repeat_id: REP.id, p_partner_id: PARTNER.id });
chk(!oldSend.ok && /schema cache|function/i.test(oldSend.msg),
  `  dp_send_to_partner is GONE — the partner is the FM's choice now`);

const noPhotoHandover = await rpc('delivery', 'dp_handover_to_partner', { p_repeat_id: REP.id, p_photo_url: '' });
chk(!noPhotoHandover.ok && /photo/i.test(noPhotoHandover.msg),
  '  Handover to the partner without a photo is REFUSED');

const out = await rpc('delivery', 'dp_handover_to_partner', { p_repeat_id: REP.id, p_photo_url: PHOTO });
chk(out.ok && out.body?.current_status === 'handed_off',
  `  Handover WITH a photo → ${out.ok ? out.body?.current_status : out.msg}`);

row = await dpRow();
chk(row?.tab === 'pickup', `  the row moved to the Pickup tab (is ${row?.tab})`);
chk(!!row?.handed_off_at, '  the SLA clock is running (handed_off_at stamped)');

const partnerWork = await rpc('partner', 'partner_active_work');
chk((partnerWork.body ?? []).some((r) => r.repeat_id === REP.id),
  '  the finishing partner sees it in their READ-ONLY active work list');
// 0092: the partner presses nothing. The row is collectable with no flag set,
// which is the point — waiting on a partner-side button meant waiting on
// something that may never be sent.
chk(row?.partner_ready_at == null,
  '  and no partner-ready flag is set, yet the piece is collectable anyway');

const noPhotoBack = await rpc('delivery', 'dp_collect_from_partner', { p_repeat_id: REP.id, p_photo_url: '' });
chk(!noPhotoBack.ok && /photo/i.test(noPhotoBack.msg), '  Collect back without a photo is REFUSED');
chk((await rpc('delivery', 'dp_collect_from_partner', { p_repeat_id: REP.id, p_photo_url: PHOTO })).ok,
  '  Collect back WITH a photo → returned_to_delivery');

row = await dpRow();
chk(row?.tab === 'delivery' && row?.destination_kind === 'qa',
  `  back in Delivery, this time bound for the Inspector (is ${row?.tab}/${row?.destination_kind})`);
const handBackGone = await rpc('delivery', 'dp_hand_back_to_floor', { p_repeat_id: REP.id });
chk(!handBackGone.ok && /schema cache|function/i.test(handBackGone.msg),
  '  dp_hand_back_to_floor is GONE — the piece goes to the Inspector, not back to the floor');

// ===========================================================================
head('  FIX 6 (as amended by 0092) — the drop-off at the Inspector advances the stage');
// ===========================================================================
const noPhotoQa = await rpc('delivery', 'dp_deliver_to_qa', { p_repeat_id: REP.id, p_photo_url: '' });
chk(!noPhotoQa.ok && /photo/i.test(noPhotoQa.msg), '  Deliver to the Inspector without a photo is REFUSED');
const collected = await rpc('delivery', 'dp_deliver_to_qa', { p_repeat_id: REP.id, p_photo_url: PHOTO });
chk(collected.ok, `DP delivers to the Inspector → ${collected.ok ? 'ok' : collected.msg}`);
const confirmGone = await rpc('floor', 'fm_confirm_collection', { p_repeat_id: REP.id });
chk(!confirmGone.ok && /schema cache|function/i.test(confirmGone.msg),
  '  fm_confirm_collection is GONE — there is nothing left for the FM to confirm');
st = await repeatNow();
chk(st.current_stage_index === 2, `  advanced to stage 2 (is ${st.current_stage_index})`);
chk(st.current_status === 'stage_qa',
  `  and lands on STAGE QA, not in_progress (is ${st.current_status})`);
chk(st.current_partner_id === null && st.current_delivery_id === null,
  '  the finished leg\'s courier and partner are cleared');

// ===========================================================================
head(`  FIX 3 again — the LAST stage passes straight to Final QA (${STAGE2})`);
// ===========================================================================
const passless2 = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: REP.id, p_photo_url: '' });
chk(!passless2.ok && /photo/i.test(passless2.msg), 'the returned work also needs a photo to pass');

const passed2 = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: REP.id, p_photo_url: PHOTO });
chk(passed2.ok && passed2.body?.current_status === 'awaiting_final_qa',
  `last stage passes → ${passed2.ok ? passed2.body?.current_status : passed2.msg} (no courier trip to nowhere)`);

const strayHandover = await rpc('floor', 'fm_hand_over_stage', {
  p_repeat_id: REP.id, p_delivery_id: DP.id, p_partner_id: PARTNER.id,
});
chk(!strayHandover.ok, '  and no handover is offered or accepted from there');

// ===========================================================================
head('  FIX 7 — Final QA shows the whole journey');
// ===========================================================================
const journey = await rpc('floor', 'fm_order_journey', { p_order_id: ORDER });
chk(journey.ok, `fm_order_journey → ${journey.ok ? `${journey.body.length} event(s)` : journey.msg}`);
const J = journey.body ?? [];
const mineJ = J.filter((e) => e.repeat_id === REP.id);

const statuses = mineJ.map((e) => e.status);
const wanted = [
  'in_progress', 'stage_qa', 'handover_for_delivery',
  'handed_over', 'handed_off', 'returned_to_delivery',
  'stage_qa', 'awaiting_final_qa',
];
for (const w of new Set(wanted)) {
  chk(statuses.includes(w), `  the journey records "${w.replace(/_/g, ' ')}"`);
}
chk(mineJ.some((e) => e.stage_sequence === 1 && e.stage_type === STAGE1), `  stage 1 is named (${STAGE1})`);
chk(mineJ.some((e) => e.stage_sequence === 2 && e.stage_type === STAGE2), `  stage 2 is named (${STAGE2})`);
chk(mineJ.some((e) => e.actor_role === 'qa') && mineJ.some((e) => e.actor_role === 'floor_manager')
    && mineJ.some((e) => e.actor_role === 'delivery'),
  '  it names WHO handled each step, by role');
chk(mineJ.some((e) => e.partner_name === PARTNER.name), `  and which finishing partner (${PARTNER.name})`);
chk(mineJ.filter((e) => e.photo_url).length >= 4, `  the photos are attached (${mineJ.filter((e) => e.photo_url).length} events carry one)`);
chk(mineJ.some((e) => e.handed_off_at && e.returned_at), '  with the out-and-back timestamps of the partner leg');
chk(mineJ.every((e, i) => i === 0 || e.created_at >= mineJ[i - 1].created_at), '  in chronological order');

const qaJourney = await rpc('qa', 'fm_order_journey', { p_order_id: ORDER });
chk(qaJourney.ok, '  QA can read it too (they sign the final pass)');
const dpJourney = await rpc('delivery', 'fm_order_journey', { p_order_id: ORDER });
chk(!dpJourney.ok, '  the delivery person cannot — it is not their record to review');

// ---------------------------------------------------------------------------
head('  8. The two final gates still close');
// ---------------------------------------------------------------------------
const fmFinal = await rpc('floor', 'fm_final_qa_pass', { p_repeat_id: REP.id });
chk(fmFinal.ok && fmFinal.body?.status === 'awaiting_qa_final',
  `fm_final_qa_pass → ${fmFinal.ok ? fmFinal.body?.status : fmFinal.msg}`);

const qaFinalNoPhoto = await rpc('qa', 'qa_final_pass', { p_repeat_id: REP.id, p_photo_url: '' });
chk(!qaFinalNoPhoto.ok && /photo/i.test(qaFinalNoPhoto.msg), '  the final pass still demands a photo');

const qaFinal = await rpc('qa', 'qa_final_pass', { p_repeat_id: REP.id, p_photo_url: PHOTO, p_note: 'wf fixes' });
chk(qaFinal.ok && qaFinal.body?.status === 'completed',
  `qa_final_pass → ${qaFinal.ok ? qaFinal.body?.status : qaFinal.msg}`);

info(`${CODE} walked ${STAGE1} → ${STAGE2} → Final QA. Second repeat left mid-loop on purpose.`);
report();
process.exit(fail ? 1 : 0);
