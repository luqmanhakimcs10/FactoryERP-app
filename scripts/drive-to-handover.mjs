/**
 * Drive ONE clean order until every repeat has left the floor, so the handover
 * back to the store can actually be exercised.
 *
 * Note it does NOT drive to `orders.status = 'awaiting_final_qa'`. That value is
 * in the orders CHECK constraint but nothing ever sets it (see 0078): an order
 * stays `in_finishing` until final QA moves it to `ready_for_delivery`. The
 * condition that matters is per-repeat, which is what the gate now reads.
 *
 *   node scripts/drive-to-handover.mjs [alpha]              walk to handover
 *   node scripts/drive-to-handover.mjs [alpha] --fixture    stop in production
 *
 * WHY THIS EXISTS SEPARATELY FROM walk-order-lifecycle
 * ---------------------------------------------------
 * That walk deliberately REJECTS a piece at initial QA to exercise the return
 * loop, and 0059 then (correctly) refuses to complete repeat QA until the piece
 * has been through the vendor and re-inspected. So it never reaches production,
 * which means it can never produce an order for the handover to act on. This
 * drives the clean path instead: every piece passes, and the order goes all the
 * way to the point where the floor is finished with it.
 *
 * It is a data DRIVER, not a test — it asserts only enough to stop early with a
 * useful message. `verify:store` is what makes the assertions once the data is
 * here.
 *
 * Anon key and real logins only, so every assert_role and RLS gate is exercised
 * rather than bypassed.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL, KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const FACTORY = (process.argv[2] ?? 'alpha').toLowerCase();
/**
 * --fixture leaves the order IN PRODUCTION with two stages instead of walking it
 * out. verify-stage-handover, verify-five-fixes and verify-escape-hatches all
 * need a repeat sitting mid-stage and have been failing for want of one — not
 * because the code is wrong but because nothing in the repo produced that state.
 * One flag is cheaper than three suites each seeding their own.
 */
const FIXTURE = process.argv.includes('--fixture');
const PHOTO = `${FACTORY}/drive/photo.jpg`;

const T = {}, UID = {};
const login = async (who) => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${who}@${FACTORY}.test`, password: 'Password123!' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed: ${who}@${FACTORY}.test`);
  T[who] = j.access_token;
  UID[who] = j.user?.id;
  return j.access_token;
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
const step = (m) => console.log('  ' + m);
const bail = (m) => { console.log('\n  STOPPED: ' + m + '\n'); process.exit(1); };

console.log(`\n  Driving one order to handover — factory: ${FACTORY}\n`);

for (const who of ['order', 'qa', 'floor', 'store', 'delivery', 'owner']) await login(who);

// ---------------------------------------------------------------------------
// Masters this needs. Created only if missing — never duplicated.
// ---------------------------------------------------------------------------
let vendors = await get('order', 'vendors?select=id,name&deleted_at=is.null&limit=1');
if (!vendors.length) bail('no client master — add one first');

let partners = await get('floor', 'finishing_partners?select=id,name,stage_type&deleted_at=is.null');
step(`masters: ${vendors.length} client(s), ${partners.length} finishing partner(s)`);

// A machine with a worker to run it, for the machine-assignment step.
//
// `assert_my_machine` lets a company_admin see every machine but a FLOOR MANAGER
// only the ones they manage — an unmanaged machine 404s for them, deliberately.
// A freshly reset masters table has managed_by null everywhere, so the owner
// assigns one here. That is a setup action the owner really does own, not a
// workaround for the rule.
let machines = await get('floor', 'machines?select=id,name,managed_by&deleted_at=is.null');
if (!machines.length) bail('no machine master — add one first');

if (!machines.some((m) => m.managed_by === UID.floor)) {
  const all = await get('owner', 'machines?select=id,name,managed_by&deleted_at=is.null&limit=1');
  if (!all.length) bail('no machine visible even to the owner');
  const r = await fetch(`${URL_}/rest/v1/machines?id=eq.${all[0].id}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${T.owner}`,
               'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ managed_by: UID.floor }),
  });
  if (!r.ok) bail(`could not give ${all[0].name} to the floor manager: HTTP ${r.status}`);
  step(`owner assigned ${all[0].name} to the floor manager`);
  machines = await get('floor', 'machines?select=id,name,managed_by&deleted_at=is.null');
}
const managed = machines.filter((m) => m.managed_by === UID.floor);
if (!managed.length) bail('the floor manager still manages no machine');
const workers = await get('floor', "profiles?select=id,display_name&role=eq.worker&is_active=is.true&limit=1");
if (!workers.length) bail('no active worker to open a shift with');

// ---------------------------------------------------------------------------
// 1. Order taker — create and submit against a well-stocked colour
// ---------------------------------------------------------------------------
const stock = await get(
  'order',
  'thread_stock?select=color_code,quantity_meters&order=quantity_meters.desc&limit=1'
);
if (!stock.length) bail('no thread stock — run 0009 or add stock first');
const color = stock[0].color_code;

const created = await rpc('order', 'create_order', {
  p_vendor_id: vendors[0].id,
  p_sheets: [{ color_assignment: 'Handover drive', repeats_count: 2, stitch_count: 1000,
               thread_color_codes: [color] }],
  p_cloth_photos: [PHOTO],
  p_design_sheet_url: null,
});
if (!created.ok) bail(`create_order: ${created.msg}`);
const orderId = created.body?.id ?? created.body?.order_id;
const orderCode = created.body?.order_code;
step(`created ${orderCode} on ${color} (${Number(stock[0].quantity_meters).toLocaleString()} in stock)`);

const submitted = await rpc('order', 'submit_order', { p_order_id: orderId });
if (!submitted.ok) bail(`submit_order: ${submitted.msg}`);
if (submitted.body?.status !== 'awaiting_cloth_inspection') {
  bail(`submitted into ${submitted.body?.status} — needed sufficient stock for this drive`);
}
step(`submitted -> awaiting_cloth_inspection, material request ${submitted.body?.material_request_id ? 'raised' : 'MISSING'}`);

// ---------------------------------------------------------------------------
// 2. QA — accept cloth, pass EVERY piece (no rejection, see the header)
// ---------------------------------------------------------------------------
if (!(await rpc('qa', 'qa_accept_cloth', { p_order_id: orderId })).ok) bail('qa_accept_cloth failed');
const sheets = await get('qa', `sheets?order_id=eq.${orderId}&select=id,repeats_count`);
for (const s of sheets) {
  for (let i = 0; i < s.repeats_count; i++) {
    const p = await rpc('qa', 'qa_pass_piece', {
      p_order_id: orderId, p_sheet_id: s.id, p_photo_url: PHOTO });
    if (!p.ok) bail(`qa_pass_piece: ${p.msg}`);
  }
}
const codedQa = await rpc('qa', 'qa_complete_repeat_qa', { p_order_id: orderId });
if (!codedQa.ok) bail(`qa_complete_repeat_qa: ${codedQa.msg}`);
step(`all pieces passed -> ${codedQa.body?.status}`);

// ---------------------------------------------------------------------------
// 3. Floor manager — stages, job card, confirm, ask for material
// ---------------------------------------------------------------------------
// One stage keeps the loop below short; outsourced so the delivery legs and the
// finishing partner are exercised, which is what mounts and unmounts touch.
const partner = partners.find((p) => p.stage_type === 'embroidery') ?? partners[0];
// One stage keeps the walk short; the fixture needs TWO, because that is what
// verify-stage-handover requires to exercise a mid-sequence handover.
const stages = [{ stage_type: partner?.stage_type ?? 'embroidery',
                  is_outsourced: !!partner, sla_hours: 24, partner_id: partner?.id ?? null }];
if (FIXTURE) {
  const second = ['press', 'clipping', 'piko'].find((t) => t !== stages[0].stage_type);
  stages.push({ stage_type: second, is_outsourced: false, sla_hours: 12, partner_id: null });
  // THREE, not two. verify-stage-handover's own message says ">=2 stages", but
  // its real condition is a repeat with two stages STILL TO RUN
  // (current_stage_index <= total - 2), which a two-stage order can never
  // satisfy for a repeat starting at index 1. Two stages produced the same
  // "no suitable order" failure as none at all.
  const third = ['press', 'clipping', 'piko', 'embroidery']
    .find((t) => !stages.some((st) => st.stage_type === t));
  if (third) stages.push({ stage_type: third, is_outsourced: false, sla_hours: 12, partner_id: null });
}
const seq = await rpc('floor', 'fm_set_stage_sequence', {
  p_order_id: orderId,
  p_stages: stages,
});
if (!seq.ok) bail(`fm_set_stage_sequence: ${seq.msg}`);

if (!(await rpc('floor', 'fm_save_job_card_design', {
  p_order_id: orderId, p_design_code: 'DRIVE-01', p_stitches_per_repeat: 1000 })).ok) {
  bail('fm_save_job_card_design failed');
}
const gen = await rpc('floor', 'fm_generate_job_card', { p_order_id: orderId });
if (!gen.ok) bail(`fm_generate_job_card: ${gen.msg}`);
const card = (await get('floor', `job_cards?order_id=eq.${orderId}&select=id,status`))[0];

const informed = await rpc('floor', 'fm_mark_vendor_informed', { p_order_id: orderId });
if (!informed.ok) bail(`fm_mark_vendor_informed: ${informed.msg}`);
const asked = await rpc('floor', 'fm_ask_for_material', { p_order_id: orderId });
if (!asked.ok) bail(`fm_ask_for_material: ${asked.msg}`);
step(`job card ${card?.id ? 'built' : 'MISSING'}, confirmed, material requested`);

// ---------------------------------------------------------------------------
// 4. Store issues, floor accepts
// ---------------------------------------------------------------------------
const issued = await rpc('store', 'sm_issue_materials', {
  p_job_card_id: card.id, p_note: 'handover drive' });
if (!issued.ok) bail(`sm_issue_materials: ${issued.msg}`);
const issueId = issued.body?.material_issue_id;
const acc = await rpc('floor', 'fm_accept_inventory', {
  p_material_issue_id: issueId, p_photo_url: PHOTO });
if (!acc.ok) bail(`fm_accept_inventory: ${acc.msg}`);
step(`issued ${issued.body?.lines} line(s), ${issued.body?.total_meters} total; accepted`);

// ---------------------------------------------------------------------------
// 5. Machine + shift, then production
//
// This is the step that proves 0076: the machine only becomes known here, which
// is why mounting had to move out of sm_issue_materials.
// ---------------------------------------------------------------------------
const machine = managed[0];
const assign = await rpc('floor', 'fm_assign_machine_with_shift', {
  p_order_id: orderId,
  p_machine_id: machine.id,
  p_worker_id: workers[0].id,
  p_worker_photo_url: PHOTO,
  p_reported_start_time: null,
  p_open_photo_url: PHOTO,
  p_open_stitches: 0,
});
if (!assign.ok) bail(`fm_assign_machine_with_shift: ${assign.msg}`);

const mounted = await rpc('floor', 'machine_mounted_list', { p_machine_id: machine.id });
step(`assigned ${machine.name}; ${(mounted.body ?? []).length} item(s) now ON MACHINE`);

const start = await rpc('floor', 'fm_start_production', { p_order_id: orderId });
if (!start.ok) bail(`fm_start_production: ${start.msg}`);
step('production started');

if (FIXTURE) {
  const reps = await get('floor', `repeats?sheet_id=in.(${sheets.map((s2) => s2.id).join(',')})&select=repeat_code,current_status`);
  step(`fixture ready: ${orderCode} in production, ${stages.length} stages, ` +
       `${reps.length} repeat(s) at ${[...new Set(reps.map((r) => r.current_status))].join('/')}`);
  console.log(
    '\n  Now run the suites that need a mid-stage repeat:\n' +
    '    npm run verify:handover   npm run verify:fivefixes   npm run verify:escapes\n'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 6. The per-repeat stage loop
//
// Driven off each repeat's CURRENT status rather than a fixed script, so it
// follows whatever the state machine actually does instead of assuming.
// ---------------------------------------------------------------------------
const repeats = await get('floor', `repeats?sheet_id=in.(${sheets.map((s) => s.id).join(',')})&select=id,repeat_code,current_status`);
step(`walking ${repeats.length} repeat(s) through the stage loop`);

for (const rep of repeats) {
  for (let guard = 0; guard < 40; guard++) {
    const row = (await get('floor', `repeats?id=eq.${rep.id}&select=current_status`))[0];
    const st = row?.current_status;
    if (st === 'awaiting_final_qa' || st === 'awaiting_qa_final' || st === 'completed') break;

    let r;
    switch (st) {
      case 'ready_for_production':
      case 'in_progress':             r = await rpc('floor', 'fm_send_to_stage_qa', { p_repeat_id: rep.id }); break;
      case 'stage_qa':                r = await rpc('qa', 'qa_pass_stage_qa', { p_repeat_id: rep.id }); break;
      case 'handover_for_delivery':   r = await rpc('floor', 'fm_hand_over_stage', { p_repeat_id: rep.id }); break;
      case 'awaiting_dp_collection':  r = await rpc('delivery', 'dp_collect_from_floor', { p_repeat_id: rep.id, p_photo_url: PHOTO }); break;
      case 'handed_over':             r = await rpc('delivery', 'dp_send_to_partner', { p_repeat_id: rep.id, p_partner_id: partner?.id }); break;
      case 'handed_off':              r = await rpc('delivery', 'dp_collect_from_partner', { p_repeat_id: rep.id, p_photo_url: PHOTO }); break;
      case 'returned_to_delivery':    r = await rpc('delivery', 'dp_hand_back_to_floor', { p_repeat_id: rep.id }); break;
      case 'awaiting_fm_collection':  r = await rpc('floor', 'fm_confirm_collection', { p_repeat_id: rep.id }); break;
      default: bail(`${rep.repeat_code} sat at an unexpected status "${st}"`);
    }
    if (!r.ok) bail(`${rep.repeat_code} at "${st}": ${r.msg}`);
  }
  const end = (await get('floor', `repeats?id=eq.${rep.id}&select=current_status`))[0];
  step(`  ${rep.repeat_code} -> ${end?.current_status}`);
}

const finalOrder = (await get('floor', `orders?id=eq.${orderId}&select=order_code,status`))[0];
step(`${finalOrder?.order_code} is now "${finalOrder?.status}"`);

const queue = await rpc('floor', 'fm_handover_queue', {});
const inQueue = (queue.body ?? []).some((o) => o.order_id === orderId);
step(`fm_handover_queue lists it: ${inQueue ? 'YES' : 'no'} (${(queue.body ?? []).length} order(s) waiting)`);

console.log(
  inQueue
    ? '\n  Ready. Run `npm run verify:store` — section 6 can now exercise the real handover.\n'
    : `\n  ${finalOrder?.status} is not a handover status; section 6 will still skip.\n`
);
