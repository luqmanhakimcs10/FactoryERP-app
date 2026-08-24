/**
 * 0092 — the simplified delivery cycle, end to end, against the live database.
 *
 *   node scripts/verify-delivery-cycle.mjs [alpha|beta]
 *
 * Anon key + real logins only: exactly the surface the app has, so RLS and every
 * assert_role / assert_module gate is exercised rather than assumed.
 *
 * WHAT IT PROVES, point by point against the brief:
 *
 *   1. The finishing partner presses NOTHING. The piece is collectable from the
 *      Pickup tab with no partner-side call made, and both partner-facing RPCs
 *      remain non-gating.
 *   2. TWO tabs, FOUR statuses. A piece walks Delivery -> In Pickup -> Delivery
 *      -> Completion, and `dp_orders_queue` files each leg in the right tab with
 *      the right destination.
 *   3. Embroidery never reaches the delivery person. Asserted by walking a piece
 *      through stage 1 and checking the queue is empty for it the whole time.
 *   4. QA passing surfaces the piece to the FLOOR MANAGER for the next handover,
 *      with no "with manager" state in between — and the status board carries no
 *      "With Manager after ..." row at all.
 *   5. The Inspector goes straight into Start QA: the first piece decision opens
 *      an order still sitting at awaiting_cloth_inspection.
 *   6. The role is named "Inspector" in `roles`.
 *   8. (colours are a client concern — see StageProgress; nothing to assert here)
 *
 * It also proves the four RETIRED callables are gone from the REST surface, not
 * merely unused: a transition out of a state the app can no longer enter is the
 * dead end this codebase keeps rediscovering.
 *
 * TWO STAGES ARE WALKED, not one. The brief asks for it explicitly, and it is
 * the only way to see the loop CLOSE — the second handover can only exist if
 * QA's pass on the first put the piece back in the Floor Manager's hands.
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
const PHOTO = `${FACTORY}/cycle/photo.jpg`;

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

/**
 * Is this function GONE, or did it merely refuse the row?
 *
 * PostgREST answers 404 to both, which is the trap this helper exists for:
 *   PGRST202  the function is not in the schema cache — it is dropped
 *   PGRST116  the function ran and raised not-found (a nil uuid, an unlinked
 *             partner profile) — it is very much still there
 * Asserting on the status alone reported four live functions as dropped and
 * one dropped function as live, all at once.
 */
const gone = (r) => r.body?.code === 'PGRST202';

function bail(why) {
  console.log(`\n  STOPPED: ${why}`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  console.log(`\n  Delivery cycle (0092) — factory: ${FACTORY}\n`);

  for (const who of ['owner', 'order', 'qa', 'floor', 'store', 'delivery', 'partner']) {
    T[who] = await login(who);
    if (!T[who]) bail(`could not sign in as ${who}@${FACTORY}.test`);
  }
  ok('signed in as order_taker, inspector, floor_manager, store_manager, delivery, partner, owner');

  // -------------------------------------------------------------------------
  // 6. The role is called Inspector.
  // -------------------------------------------------------------------------
  console.log('\n  6. The role label');
  const roles = await get('owner', 'roles?key=eq.qa&select=key,name');
  chk(roles.body?.[0]?.name === 'Inspector',
    `roles.qa.name is "${roles.body?.[0]?.name}" (expected "Inspector")`);

  // -------------------------------------------------------------------------
  // The retired callables are GONE from the REST surface.
  // -------------------------------------------------------------------------
  console.log('\n  The two removed stops are dropped, not merely unused');
  for (const [who, fn, args] of [
    ['delivery', 'dp_collect_from_floor', { p_repeat_id: NIL, p_photo_url: 'x.jpg' }],
    ['delivery', 'dp_hand_back_to_floor', { p_repeat_id: NIL }],
    ['floor', 'fm_confirm_collection', { p_repeat_id: NIL }],
    ['floor', 'fm_pending_collections', { p_order_id: NIL }],
  ]) {
    const r = await rpc(who, fn, args);
    chk(gone(r), `${fn} is DROPPED (${r.body?.code ?? r.status})`);
  }

  // The new one exists. Probed with a nil id so it refuses during validation
  // and writes nothing — which is PGRST116, not PGRST202.
  const newFn = await rpc('delivery', 'dp_deliver_to_qa', { p_repeat_id: NIL, p_photo_url: 'x.jpg' });
  chk(!gone(newFn), `dp_deliver_to_qa EXISTS (${newFn.body?.code ?? newFn.status}: ${newFn.msg})`);

  // Kept on purpose: the screen went, the capability did not.
  for (const [who, fn, args] of [
    ['qa', 'qa_accept_cloth', { p_order_id: NIL }],
    ['partner', 'partner_ready_for_collection', { p_repeat_id: NIL }],
  ]) {
    const r = await rpc(who, fn, args);
    chk(!gone(r), `${fn} is deliberately KEPT (${r.body?.code ?? r.status}: ${r.msg})`);
  }

  // -------------------------------------------------------------------------
  // 5. The Inspector goes straight into Start QA.
  // -------------------------------------------------------------------------
  console.log('\n  5. Tapping an order opens Start QA — no cloth-acceptance step');

  const vendors = await get('order', 'vendors?select=id,name&deleted_at=is.null&limit=1');
  if (!vendors.body?.length) bail(`${FACTORY} has no client master`);
  const stock = await get(
    'order',
    'thread_stock?select=color_code,quantity_meters&order=quantity_meters.desc&limit=1'
  );
  if (!stock.body?.length) bail(`${FACTORY} has no thread stock seeded`);

  const created = await rpc('order', 'create_order', {
    p_vendor_id: vendors.body[0].id,
    p_sheets: [{
      color_assignment: 'Cycle test',
      repeats_count: 2,
      stitch_count: 1000,
      thread_color_codes: [stock.body[0].color_code],
    }],
    p_cloth_photos: [PHOTO],
    p_design_sheet_url: null,
  });
  if (!created.ok) bail(`create_order refused: ${created.msg}`);
  const orderId = created.body.id;
  info(`created ${created.body.order_code}`);

  const submitted = await rpc('order', 'submit_order', { p_order_id: orderId });
  if (!submitted.ok) bail(`submit_order refused: ${submitted.msg}`);
  let status = (await get('order', `orders?id=eq.${orderId}&select=status`)).body?.[0]?.status;
  if (status === 'awaiting_procurement') {
    bail('submitted into awaiting_procurement (thread shortfall) — out of scope here');
  }
  chk(status === 'awaiting_cloth_inspection',
    `submitted → ${status}, with nobody having looked at it yet`);

  const sheets = await get('qa', `sheets?order_id=eq.${orderId}&select=id,repeats_count`);
  const sheet = sheets.body[0];

  // THE ASSERTION. A pass fired at an order nobody accepted must work AND move
  // the order itself.
  const firstPass = await rpc('qa', 'qa_pass_piece', {
    p_order_id: orderId, p_sheet_id: sheet.id, p_photo_url: PHOTO,
  });
  chk(firstPass.ok,
    `qa_pass_piece on an UNACCEPTED order → ${firstPass.ok ? firstPass.body?.repeat_code : firstPass.msg}`);
  const afterFirst = await get('qa', `orders?id=eq.${orderId}&select=status,inspected_at`);
  chk(afterFirst.body?.[0]?.status === 'awaiting_coding',
    `  and it opened the order itself → ${afterFirst.body?.[0]?.status}`);
  chk(afterFirst.body?.[0]?.inspected_at != null, '  stamping inspected_at as it went');

  for (let i = 1; i < sheet.repeats_count; i++) {
    const p = await rpc('qa', 'qa_pass_piece', { p_order_id: orderId, p_sheet_id: sheet.id, p_photo_url: PHOTO });
    if (!p.ok) bail(`qa_pass_piece ${i + 1}: ${p.msg}`);
  }
  const doneQa = await rpc('qa', 'qa_complete_repeat_qa', { p_order_id: orderId });
  chk(doneQa.ok && doneQa.body?.status === 'awaiting_job_card',
    `every piece passed → ${doneQa.ok ? doneQa.body?.status : doneQa.msg}`);

  // -------------------------------------------------------------------------
  // Drive to production. Three stages, so TWO finishing round trips.
  //
  // Every call here mirrors `walk:lifecycle` exactly — this section is
  // scaffolding, not the thing under test, and a second, subtly different way
  // of driving an order to the floor is a second thing that can be wrong.
  // -------------------------------------------------------------------------
  /*
   * THE STAGES ARE CHOSEN FROM THE PARTNERS ON FILE, not hardcoded.
   *
   * `fm_hand_over_stage` validates the partner against the DESTINATION stage's
   * type, so a sequence naming a stage nobody handles cannot be walked — and
   * which stages a factory has partners for is data, not a fact about the app.
   * Alpha has clipping and piko but no press; hardcoding press would fail on
   * the second round trip and look like a bug in the cycle.
   */
  const partners = await get('floor', 'finishing_partners?select=id,name,stage_type&deleted_at=is.null');
  const outsourced = ['clipping', 'press', 'piko'].filter((t) =>
    (partners.body ?? []).some((pp) => pp.stage_type === t));
  if (outsourced.length < 2) {
    bail(`${FACTORY} has finishing partners for ${outsourced.length} outsourced stage(s) — two are needed to walk the loop twice`);
  }
  const legStages = outsourced.slice(0, 2);
  info(`stage sequence: embroidery → ${legStages.join(' → ')}`);

  console.log('\n  Driving the order to production');
  const seq = await rpc('floor', 'fm_set_stage_sequence', {
    p_order_id: orderId,
    p_stages: [
      { stage_type: 'embroidery', is_outsourced: false, sla_hours: 24, partner_id: null },
      ...legStages.map((t) => ({ stage_type: t, is_outsourced: true, sla_hours: 24, partner_id: null })),
    ],
  });
  if (!seq.ok) bail(`fm_set_stage_sequence refused: ${seq.msg}`);

  const design = await rpc('floor', 'fm_save_job_card_design', {
    p_order_id: orderId, p_design_code: 'CYCLE-0092', p_stitches_per_repeat: 1000,
  });
  if (!design.ok) bail(`fm_save_job_card_design refused: ${design.msg}`);
  const gen = await rpc('floor', 'fm_generate_job_card', { p_order_id: orderId });
  if (!gen.ok) bail(`fm_generate_job_card refused: ${gen.msg}`);

  const informed = await rpc('floor', 'fm_mark_vendor_informed', { p_order_id: orderId });
  if (!informed.ok) bail(`fm_mark_vendor_informed refused: ${informed.msg}`);
  // 0088 folded the material request into `fm_mark_vendor_informed`, so this
  // may legitimately come back "already been requested". Either way the request
  // exists, which is all this scaffolding needs — the store queue below is the
  // real check on it.
  const asked = await rpc('floor', 'fm_ask_for_material', { p_order_id: orderId });
  if (!asked.ok) info(`fm_ask_for_material: ${asked.msg}`);

  const smQueue = await rpc('store', 'material_issue_queue');
  const smRow = (smQueue.body ?? []).find((r) => r.order_id === orderId);
  if (!smRow) bail('the order never reached the store manager\'s material queue');
  const issued = await rpc('store', 'sm_issue_materials', {
    p_job_card_id: smRow.job_card_id, p_note: 'delivery cycle test',
  });
  if (!issued.ok) bail(`sm_issue_materials refused: ${issued.msg}`);

  const fmQueue = await rpc('floor', 'fm_material_issue_queue');
  const fmRow = (fmQueue.body ?? []).find((r) => r.order_id === orderId);
  if (!fmRow) bail('the issue never reached the floor manager\'s Accept inventory tab');
  const issueLines = await rpc('floor', 'fm_material_issue_lines', {
    p_material_issue_id: fmRow.material_issue_id,
  });
  const accept = await rpc('floor', 'fm_accept_inventory', {
    p_material_issue_id: fmRow.material_issue_id,
    p_photo_url: PHOTO,
    p_received_item_ids: (issueLines.body ?? []).map((l) => l.item_id),
  });
  if (!accept.ok) bail(`fm_accept_inventory refused: ${accept.msg}`);

  // fm_assign_machine refuses a floor manager any machine whose managed_by is
  // not their own uid — an unmanaged machine is NOT usable here.
  const machines = await get('floor', 'machines?select=id,name,managed_by&deleted_at=is.null');
  const mine = (machines.body ?? []).filter((m) => m.managed_by === T.floor.userId);
  if (!mine.length) {
    bail(`no machine is managed by floor@${FACTORY}.test (or Machine & Workforce is off) — production is out of scope here`);
  }
  const assigned = await rpc('floor', 'fm_assign_machine', {
    p_order_id: orderId, p_machine_id: mine[0].id,
  });
  if (!assigned.ok) bail(`fm_assign_machine refused: ${assigned.msg}`);
  const started = await rpc('floor', 'fm_start_production', { p_order_id: orderId });
  if (!started.ok) bail(`fm_start_production refused: ${started.msg}`);
  ok(`order is in production on ${mine[0].name}`);

  const reps = await get('floor', `repeats?select=id,repeat_code,current_status,current_stage_index&sheet_id=eq.${sheet.id}&order=repeat_code`);
  const rep = reps.body?.[0];
  if (!rep) bail('no repeats on the sheet');
  info(`walking ${rep.repeat_code}`);

  const dpPeople = await rpc('floor', 'fm_delivery_people');
  const courier = (dpPeople.body ?? [])[0];
  if (!courier) bail('no delivery person on file');

  // -------------------------------------------------------------------------
  // 3. Embroidery never involves the delivery person.
  // -------------------------------------------------------------------------
  console.log('\n  3. Embroidery — in-house, and invisible to the delivery person');
  const inQueue = async () => {
    const q = await rpc('delivery', 'dp_orders_queue');
    return (q.body ?? []).find((r) => r.repeat_id === rep.id) ?? null;
  };
  chk((await inQueue()) === null,
    'the piece is on the machine at stage 1 and is NOT in the delivery queue');

  const toQa1 = await rpc('floor', 'fm_send_to_stage_qa', { p_repeat_id: rep.id });
  chk(toQa1.ok, `fm_send_to_stage_qa → ${toQa1.ok ? toQa1.body?.current_status : toQa1.msg}`);
  chk((await inQueue()) === null,
    'still not in the delivery queue while embroidery is at Stage QA');

  // -------------------------------------------------------------------------
  // 2 + 4. Two round trips through the four-status cycle.
  // -------------------------------------------------------------------------
  for (const leg of [
    { from: 'embroidery', to: legStages[0], index: 1 },
    { from: legStages[0], to: legStages[1], index: 2 },
  ]) {
    console.log(`\n  2+4. Round trip ${leg.index}: ${leg.from} cleared → ${leg.to}`);

    const passed = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: rep.id, p_photo_url: PHOTO });
    chk(passed.ok && passed.body?.current_status === 'handover_for_delivery',
      `Inspector passes ${leg.from} → ${passed.ok ? passed.body?.current_status : passed.msg}`);

    // POINT 4. The pass is what surfaces it to the FLOOR MANAGER, with no
    // separate waiting state to label. `fm_handover` is the queue that proves it.
    const fmQueue = await rpc('floor', 'my_queue_items', { p_queue_key: 'fm_handover' });
    chk((fmQueue.body ?? []).some((i) => i.item_id === rep.id),
      '  the pass put it straight in the Floor Manager\'s "ready to hand over" queue');
    chk((await inQueue()) === null,
      '  and NOT in the delivery queue — nothing to carry until the FM hands it over');

    const handler = (partners.body ?? []).find((p) => p.stage_type === leg.to);
    if (!handler) bail(`no finishing partner handles ${leg.to} in ${FACTORY}`);

    const handed = await rpc('floor', 'fm_hand_over_stage', {
      p_repeat_id: rep.id, p_delivery_id: courier.id, p_partner_id: handler.id,
    });
    chk(handed.ok && handed.body?.current_status === 'handed_over',
      `  FM "Handover to ${leg.to}" → ${handed.ok ? handed.body?.current_status : handed.msg} (NOT awaiting_dp_collection)`);
    if (!handed.ok) bail('handover refused');

    // ---- status 1 of 4: Delivery, bound for the partner ----
    let row = await inQueue();
    chk(row?.tab === 'delivery' && row?.destination_kind === 'partner',
      `  [1/4] DELIVERY tab, destination partner (${row?.tab}/${row?.destination_kind})`);
    chk(row?.destination_stage === leg.to,
      `  and the trip is named for ${leg.to} (is ${row?.destination_stage})`);

    const noPhoto = await rpc('delivery', 'dp_handover_to_partner', { p_repeat_id: rep.id, p_photo_url: '' });
    chk(!noPhoto.ok && /photo/i.test(noPhoto.msg), '  a photo is required to deliver');

    const out = await rpc('delivery', 'dp_handover_to_partner', { p_repeat_id: rep.id, p_photo_url: PHOTO });
    chk(out.ok && out.body?.current_status === 'handed_off',
      `  delivered to ${handler.name} → ${out.ok ? out.body?.current_status : out.msg}`);

    // ---- status 2 and 3 of 4: In Pickup, with NOTHING pressed by the partner ----
    row = await inQueue();
    chk(row?.tab === 'pickup', `  [2-3/4] PICKUP tab (is ${row?.tab})`);
    chk(row?.partner_ready_at == null,
      '  POINT 1: no partner-side flag was set, and the row is actionable anyway');

    // The partner's own view is read-only, and `partner_active_work` is the
    // whole of what they get. Whether THIS piece is on it depends on which
    // partner the `partner@` login is linked to, which is data — so that is
    // reported, not asserted. What IS asserted is that the list is readable
    // and that nothing on it is required for the collection below to work.
    const partnerWork = await rpc('partner', 'partner_active_work');
    if (partnerWork.ok) {
      chk(true, `  the partner can read their work list (${(partnerWork.body ?? []).length} item(s) with them)`);
      info((partnerWork.body ?? []).some((w) => w.repeat_id === rep.id)
        ? `  ${rep.repeat_code} is on it — the partner@ login is linked to ${handler.name}`
        : `  ${rep.repeat_code} is not on it — the partner@ login is linked elsewhere, which changes nothing`);
    } else {
      // `partner@${FACTORY}.test` is not linked to a `finishing_partners` row in
      // this database, so their own view is empty by data, not by this change.
      // Reported rather than failed: the assertion that matters is the one
      // above — the piece is collectable with no partner-side call at all.
      info(`  partner_active_work: ${partnerWork.msg} (a seed gap, not a cycle fault)`);
    }

    const backNoPhoto = await rpc('delivery', 'dp_collect_from_partner', { p_repeat_id: rep.id, p_photo_url: '' });
    chk(!backNoPhoto.ok && /photo/i.test(backNoPhoto.msg), '  a photo is required to collect back');

    const back = await rpc('delivery', 'dp_collect_from_partner', { p_repeat_id: rep.id, p_photo_url: PHOTO });
    chk(back.ok && back.body?.current_status === 'returned_to_delivery',
      `  collected back with NO partner press first → ${back.ok ? back.body?.current_status : back.msg}`);

    // ---- back to status 1 of 4, this time bound for QA ----
    row = await inQueue();
    chk(row?.tab === 'delivery' && row?.destination_kind === 'qa',
      `  [4/4 inbound] DELIVERY tab again, destination the Inspector (${row?.tab}/${row?.destination_kind})`);

    const qaNoPhoto = await rpc('delivery', 'dp_deliver_to_qa', { p_repeat_id: rep.id, p_photo_url: '  ' });
    chk(!qaNoPhoto.ok && /photo/i.test(qaNoPhoto.msg), '  a photo is required to deliver to the Inspector');

    const toInspector = await rpc('delivery', 'dp_deliver_to_qa', { p_repeat_id: rep.id, p_photo_url: PHOTO });
    chk(toInspector.ok && toInspector.body?.current_status === 'stage_qa',
      `  delivered to the Inspector → ${toInspector.ok ? toInspector.body?.current_status : toInspector.msg}`);
    chk(toInspector.body?.current_stage_index === leg.index + 1,
      `  and THE DROP-OFF advanced the stage to ${toInspector.body?.current_stage_index} — no FM confirmation in between`);

    // ---- status 4 of 4: Completion ----
    row = await inQueue();
    chk(row?.tab === 'completion',
      `  [4/4] COMPLETION for the delivery person (is ${row?.tab})`);
    chk(row?.destination_stage !== undefined && row?.stage_type === leg.to,
      `  naming the stage that was actually worked: ${row?.stage_type}`);
  }

  // The second round trip could not have started unless QA's pass on the first
  // put the piece back in the Floor Manager's hands. That is point 4, proved by
  // the loop having gone round twice rather than by an assertion about a label.
  ok('the loop CLOSED twice — QA passing is what surfaces the next handover');

  // -------------------------------------------------------------------------
  // 4b. There is no "With Manager after ..." row on the status board.
  // -------------------------------------------------------------------------
  console.log('\n  4b. The status board carries no separate "with manager" step');
  const board = await rpc('floor', 'fm_order_status_board', { p_order_id: orderId });
  if (!board.ok) {
    no(`fm_order_status_board: ${board.msg}`);
  } else {
    const mgrRows = (board.body ?? []).filter((r) => /with manager/i.test(r.label ?? ''));
    chk(mgrRows.length === 0, `0 "With Manager after ..." rows (found ${mgrRows.length})`);
    const slots = (board.body ?? []).filter((r) => r.kind === 'stage').map((r) => r.step_key);
    chk(!slots.some((k) => String(k).startsWith('mgr:')),
      `no mgr: slots on the board (${slots.filter((k) => String(k).startsWith('mgr:')).length} found)`);
    // Stage 1 keeps no handover/pickup rows: embroidery never leaves the floor.
    chk(!slots.includes('handover:1') && !slots.includes('pickup:1'),
      'stage 1 has no handover or pickup row — embroidery never leaves the building');
  }

  // -------------------------------------------------------------------------
  // The last stage still ends at Final QA rather than a trip to nowhere.
  // -------------------------------------------------------------------------
  console.log('\n  The final stage ends at Final QA, not another round trip');
  const lastPass = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: rep.id, p_photo_url: PHOTO });
  chk(lastPass.ok && lastPass.body?.current_status === 'awaiting_final_qa',
    `Inspector passes ${legStages[1]} (the last stage) → ${lastPass.ok ? lastPass.body?.current_status : lastPass.msg}`);
  chk((await inQueue()) === null,
    'and the piece leaves the delivery queue entirely — nothing left to carry');

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
