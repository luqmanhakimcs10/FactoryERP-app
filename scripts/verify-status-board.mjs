/**
 * The granular status board (0090), proved by walking a real order.
 *
 *   npm run verify:status
 *
 * WHAT THIS ACTUALLY CHECKS
 * -------------------------
 * The risky part of 0090 is not the SQL, it is the MAPPING: which
 * (current_status, current_stage_index) pair means "In Clipping" rather than
 * "In Pickup from Clipping". That mapping was derived by reading the state
 * machine, so it is checked by driving one order through every transition with
 * real logins and real RPCs, reading the pair back after each one, and
 * asserting the derived label sequence is exactly the one the brief specifies.
 *
 * The `key()` function below is a transcription of `public.repeat_status_key`.
 * It is deliberately a SECOND copy: if the two ever disagree, the cross-check
 * against `fm_repeat_status_board` at the bottom fails, which is the point.
 *
 * Anon key and real logins only, so every assert_role and RLS gate is
 * exercised rather than bypassed.
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
const API = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const PHOTO = 'verify/status-board.jpg';

let pass = 0;
let fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);
const step = (m) => console.log('   ·    ' + m);

const tokens = {};
const uids = {};
async function login(who, email) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });
  const j = await r.json().catch(() => ({}));
  tokens[who] = j?.access_token ?? null;
  uids[who] = j?.user?.id ?? null;
  return tokens[who];
}
async function rpc(who, fn, args = {}) {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${tokens[who]}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body, msg: body?.message ?? JSON.stringify(body) };
}
async function get(who, path) {
  const r = await fetch(`${API}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${tokens[who]}` },
  });
  return r.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// The mapping under test — a transcription of public.repeat_status_key.
// ---------------------------------------------------------------------------
function key(status, stageIndex) {
  const s = Math.max(stageIndex ?? 1, 1);
  switch (status) {
    case 'ready_for_production':   return `pre:${s}`;
    case 'in_progress':            return `in:${s}`;
    case 'stage_qa':               return `qa:${s}`;
    // 0092: no "with manager" key. A cleared stage reads as queued for the next.
    case 'handover_for_delivery':  return `handover:${s + 1}`;
    case 'awaiting_dp_collection': return `handover:${s + 1}`;
    case 'handed_over':            return `handover:${s + 1}`;
    case 'handed_off':             return `in:${s + 1}`;
    case 'returned_to_delivery':   return `pickup:${s + 1}`;
    case 'awaiting_fm_collection': return `pickup:${s + 1}`;
    case 'awaiting_final_qa':      return 'final';
    case 'awaiting_qa_final':      return 'final';
    case 'completed':              return 'done';
    case 'damaged':                return 'damaged';
    default:                       return 'other';
  }
}
const cap = (t) => (t ?? 'stage').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function label(k, stageNames) {
  const [kind, n] = k.split(':');
  const name = n ? cap(stageNames[Number(n) - 1]) : null;
  switch (kind) {
    case 'pre':       return `Awaiting ${name}`;
    case 'in':        return `In ${name}`;
    case 'qa':        return `Repeat Inspection after ${name}`;
    // 0092 removed the `mgr` slot. Kept in this map only so an unexpected key
    // renders as a sentence in the diff below rather than as a raw token.
    case 'mgr':       return `With Manager after ${name}`;
    case 'handover':  return `Handover to ${name} - In Delivery`;
    case 'pickup':    return `In Pickup from ${name}`;
    case 'final':     return 'Final Inspection by Manager';
    case 'done':      return 'Ready to Deliver';
    default:          return kind;
  }
}

console.log('\n  Granular status board — Alpha factory\n');

for (const [who, email] of [
  ['order', 'order@alpha.test'],
  ['qa', 'qa@alpha.test'],
  ['floor', 'floor@alpha.test'],
  ['store', 'store@alpha.test'],
  ['delivery', 'delivery@alpha.test'],
  ['owner', 'owner@alpha.test'],
]) {
  if (!(await login(who, email))) {
    console.error(`  Cannot sign in as ${email}.`);
    process.exit(2);
  }
}
ok('signed in as six roles');

// ---------------------------------------------------------------------------
// 1. Build one order with exactly two stages: Embroidery -> Clipping
// ---------------------------------------------------------------------------
const vendors = await get('order', 'vendors?select=id,name&deleted_at=is.null&limit=1');
const partners = await get('floor', 'finishing_partners?select=id,name,stage_type&deleted_at=is.null');
const clipper = (partners ?? []).find((p) => p.stage_type === 'clipping');

if (!vendors?.length) { console.error('  No client on file.'); process.exit(2); }
if (!clipper) {
  console.error('  No finishing partner covers clipping — add one and re-run.');
  process.exit(2);
}

/*
 * Pick a colour the store can actually issue, and top it up if it cannot.
 *
 * The walk needs material to be ISSUED and ACCEPTED — that is what moves the
 * order to `machine_selection_pending`, and without it Start Production is
 * refused and the whole sequence stops at "Awaiting Embroidery". A factory
 * whose thread has been consumed by earlier runs would otherwise make this
 * script look like a mapping bug.
 */
const stock = await get(
  'store',
  'inventory_items?select=id,color_code,quantity,item_type&item_type=eq.thread&order=quantity.desc&limit=1'
);
const color = stock?.[0]?.color_code ?? 'RED-01';
if (Number(stock?.[0]?.quantity ?? 0) < 50) {
  const added = await rpc('store', 'sm_add_inventory', {
    p_item_type: 'thread',
    p_color_code: color,
    p_quantity: 200,
    p_color_name: null,
    p_size_mm: null,
    p_sequin_type: null,
    p_cd_count: null,
    p_yards_per_cd: 90,
    p_note: 'topped up by verify-status-board',
  });
  info(added.ok ? `topped ${color} up to issue from` : `sm_add_inventory: ${added.msg}`);
}

const created = await rpc('order', 'create_order', {
  p_vendor_id: vendors[0].id,
  p_sheets: [
    // stitch_count 0, exactly as the New Order screen submits: a non-zero
    // figure trips the shortfall check and parks the order at
    // `awaiting_procurement`, which is a different walk from this one.
    { color_assignment: 'Red', repeats_count: 2, thread_color_codes: [color], stitch_count: 0 },
  ],
  p_cloth_photos: [PHOTO],
  p_design_sheet_url: PHOTO,
});
if (!created.ok) { console.error('  create_order: ' + created.msg); process.exit(2); }
const orderId = created.body.id;
step(`created ${created.body.order_code} with 2 repeats on ${color}`);

if (!(await rpc('order', 'submit_order', { p_order_id: orderId })).ok) {
  console.error('  submit_order failed'); process.exit(2);
}
const accepted = await rpc('qa', 'qa_accept_cloth', { p_order_id: orderId });
if (!accepted.ok) { console.error('  qa_accept_cloth: ' + accepted.msg); process.exit(2); }
const sheets = await get('qa', `sheets?select=id,repeats_count&order_id=eq.${orderId}`);
for (const sh of sheets ?? []) {
  for (let i = 0; i < sh.repeats_count; i++) {
    await rpc('qa', 'qa_pass_piece', { p_order_id: orderId, p_sheet_id: sh.id, p_photo_url: PHOTO });
  }
}
await rpc('qa', 'qa_complete_repeat_qa', { p_order_id: orderId });
step('cloth accepted, both pieces coded');

const seq = await rpc('floor', 'fm_set_stage_sequence', {
  p_order_id: orderId,
  p_stages: [
    { stage_type: 'embroidery', is_outsourced: false, sla_hours: 24, partner_id: null },
    { stage_type: 'clipping', is_outsourced: true, sla_hours: 24, partner_id: clipper.id },
  ],
});
if (!seq.ok) { console.error('  fm_set_stage_sequence: ' + seq.msg); process.exit(2); }
const stageRows = await get('floor', `order_stages?select=sequence,stage_type&order_id=eq.${orderId}&order=sequence`);
const stageNames = (stageRows ?? []).map((r) => r.stage_type);
chk(stageNames.length === 2, `the order has two stages: ${stageNames.join(' -> ')}`);

await rpc('floor', 'fm_save_job_card_design', {
  p_order_id: orderId, p_design_code: 'DS-BOARD', p_stitches_per_repeat: 1000,
});
await rpc('floor', 'fm_generate_job_card', { p_order_id: orderId });
const informed = await rpc('floor', 'fm_mark_vendor_informed', { p_order_id: orderId });
if (!informed.ok) { console.error('  fm_mark_vendor_informed: ' + informed.msg); process.exit(2); }
// Pre-0088 this is a separate press; from 0088 the call above already did it.
const asked = await rpc('floor', 'fm_ask_for_material', { p_order_id: orderId });
info(
  asked.ok
    ? 'material requested by the separate call (pre-0088 database)'
    : `Client Approved already requested the material — ${asked.msg}`
);

const card = (await get('floor', `job_cards?order_id=eq.${orderId}&select=id`))[0];
const issued = await rpc('store', 'sm_issue_materials', {
  p_job_card_id: card.id, p_note: 'status board walk',
});
if (!issued.ok) { console.error('  sm_issue_materials: ' + issued.msg); process.exit(2); }

// 0084 made acceptance itemised: every issued ITEM has to be ticked off by id,
// and the argument is `p_received_item_ids` — an unrecognised argument name
// makes PostgREST report the whole function as missing rather than complain.
const issueId = issued.body?.material_issue_id;
const issueLines = await rpc('floor', 'fm_material_issue_lines', {
  p_material_issue_id: issueId,
});
if (!issueLines.ok) { console.error('  fm_material_issue_lines: ' + issueLines.msg); process.exit(2); }
const acc = await rpc('floor', 'fm_accept_inventory', {
  p_material_issue_id: issueId,
  p_photo_url: PHOTO,
  p_received_item_ids: (issueLines.body ?? []).map((l) => l.item_id),
});
if (!acc.ok) { console.error('  fm_accept_inventory: ' + acc.msg); process.exit(2); }
/*
 * `fm_assign_machine` only accepts a machine the floor manager MANAGES — an
 * unmanaged one 404s for them by design. A freshly reset masters table has
 * `managed_by` null everywhere, so hand one over as the owner first. Without
 * this the assignment failed silently and Start Production then refused, which
 * is how the walk quietly stopped at "Awaiting Embroidery".
 */
let machines = await get('floor', 'machines?select=id,name,managed_by&deleted_at=is.null');
if (!(machines ?? []).some((m) => m.managed_by === uids.floor)) {
  const all = await get('owner', 'machines?select=id,name&deleted_at=is.null&limit=1');
  if (all?.length) {
    await fetch(`${API}/rest/v1/machines?id=eq.${all[0].id}`, {
      method: 'PATCH',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${tokens.owner}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ managed_by: uids.floor }),
    });
    machines = await get('floor', 'machines?select=id,name,managed_by&deleted_at=is.null');
  }
}
const machine = (machines ?? []).find((m) => m.managed_by === uids.floor);
if (!machine) { console.error('  the floor manager manages no machine.'); process.exit(2); }

const assigned = await rpc('floor', 'fm_assign_machine', {
  p_order_id: orderId, p_machine_id: machine.id,
});
if (!assigned.ok) {
  console.error('  fm_assign_machine: ' + assigned.msg);
  console.error('  (an order reaches machine selection only once the material has been');
  console.error('   issued by the store and accepted on the floor — check the step above.)');
  process.exit(2);
}
step(`job card approved, material issued and accepted, ${machine.name} assigned`);

// ---------------------------------------------------------------------------
// 2. Walk one repeat through every transition, recording the label each time
// ---------------------------------------------------------------------------
const repeats = await get('floor', `repeats?select=id,repeat_code,sheet_id&order=repeat_code`);
const mine = [];
for (const r of repeats ?? []) {
  const sh = (sheets ?? []).find((x) => x.id === r.sheet_id);
  if (sh) mine.push(r);
}
chk(mine.length === 2, `${mine.length} repeat(s) on the order`);
const subject = mine[0];

async function positionOf(repeatId) {
  const rows = await get('floor', `repeats?select=current_status,current_stage_index&id=eq.${repeatId}`);
  const r = rows?.[0];
  return { status: r?.current_status, index: r?.current_stage_index };
}

const observed = [];
async function record(note) {
  const p = await positionOf(subject.id);
  const k = key(p.status, p.index);
  observed.push({ k, label: label(k, stageNames), status: p.status, index: p.index });
  step(`${note.padEnd(28)} ${p.status} @${p.index}  ->  ${label(k, stageNames)}`);
}

await record('client approved');
const started = await rpc('floor', 'fm_start_production', { p_order_id: orderId });
if (!started.ok) { console.error('  fm_start_production: ' + started.msg); process.exit(2); }
await record('production started');

// The stage loop, one transition at a time.
const loop = [
  ['floor', 'fm_send_to_stage_qa', 'sent to stage QA'],
  ['qa', 'qa_pass_stage_qa', 'stage QA passed'],
  ['floor', 'fm_hand_over_stage', 'handed over — straight into the delivery tab'],
  ['delivery', 'dp_handover_to_partner', 'given to the partner'],
  ['delivery', 'dp_collect_from_partner', 'collected from partner'],
  ['delivery', 'dp_deliver_to_qa', 'delivered to the Inspector — stage advances'],
  ['qa', 'qa_pass_stage_qa', 'stage QA passed (last stage)'],
];

const couriers = await rpc('floor', 'fm_delivery_people');
const courier = (couriers.body ?? [])[0];

for (const [who, fn, note] of loop) {
  let args = { p_repeat_id: subject.id };
  if (fn === 'qa_pass_stage_qa' || fn === 'dp_handover_to_partner'
      || fn === 'dp_collect_from_partner' || fn === 'dp_deliver_to_qa') {
    args.p_photo_url = PHOTO;
  }
  if (fn === 'fm_hand_over_stage') {
    args = { p_repeat_id: subject.id, p_delivery_id: courier?.id, p_partner_id: clipper.id };
  }
  const r = await rpc(who, fn, args);
  if (!r.ok) { no(`${fn}: ${r.msg}`); break; }
  await record(note);
}

// Final QA. 0087 gave it a photo and made it terminal; try that shape first.
let finalPass = await rpc('floor', 'fm_final_qa_pass', { p_repeat_id: subject.id, p_photo_url: PHOTO });
if (!finalPass.ok) {
  finalPass = await rpc('floor', 'fm_final_qa_pass', {
    p_repeat_id: subject.id, p_note: 'status board walk',
  });
  if (finalPass.ok) info('final QA passed with the pre-0087 two-argument signature');
}
if (finalPass.ok) await record('final QA passed');
else info(`fm_final_qa_pass: ${finalPass.msg}`);

// ---------------------------------------------------------------------------
// 3. The observed sequence must be exactly the brief's
// ---------------------------------------------------------------------------
/*
 * The sequence after 0092. Four rows shorter than it was, and every one of the
 * four is a stop that has been removed rather than renamed:
 *
 *   'With Manager after Embroidery'      handover_for_delivery folds into the
 *                                        handover row — QA passing IS what
 *                                        surfaces the piece to the FM, so it
 *                                        reads as queued for the next stage
 *   the SECOND 'In Pickup from Clipping' awaiting_fm_collection is gone; the
 *                                        delivery person's drop-off at the
 *                                        Inspector advances the stage itself
 *
 * 'Handover to Clipping - In Delivery' still appears TWICE, and it is the same
 * two rows as before under different statuses: once for handover_for_delivery
 * (QA has passed it, the Floor Manager has the button) and once for
 * handed_over (the delivery person is carrying it). One label, because from the
 * floor's side both mean "cleared embroidery, not yet at the partner".
 */
const expected = [
  'Awaiting Embroidery',
  'In Embroidery',
  'Repeat Inspection after Embroidery',
  'Handover to Clipping - In Delivery',
  'Handover to Clipping - In Delivery',
  'In Clipping',
  'In Pickup from Clipping',
  'Repeat Inspection after Clipping',
  'Final Inspection by Manager',
  'Ready to Deliver',
];
const got = observed.map((o) => o.label);
chk(
  got.length === expected.length && got.every((g, i) => g === expected[i]),
  'the walk produced exactly the brief\'s status sequence'
);
if (got.length !== expected.length || !got.every((g, i) => g === expected[i])) {
  info('expected: ' + JSON.stringify(expected, null, 0));
  info('observed: ' + JSON.stringify(got, null, 0));
}

// ---------------------------------------------------------------------------
// 4. The boards themselves — once 0090 is applied
// ---------------------------------------------------------------------------
const board = await rpc('floor', 'fm_order_status_board', { p_order_id: orderId });
if (board.status === 404) {
  info('fm_order_status_board is not in the database yet — apply 0090 and re-run');
  info('for the board assertions below.');
} else {
  chk(board.ok, `the floor manager can read the order board (${board.status})`);
  const rows = board.body ?? [];

  const labels = rows.map((r) => r.label);
  for (const want of [
    'Order Creation', 'Order Inspection', 'Job Card Creation', 'Job Card Approved',
    'Raw Materials Collection', 'Machine Assignment',
    'In Embroidery', 'Repeat Inspection after Embroidery',
    'Handover to Clipping - In Delivery', 'In Clipping', 'In Pickup after Clipping',
    'Repeat Inspection after Clipping',
    'Floor Inspection by Manager', 'Ready', 'Client Delivery', 'Completed',
  ]) {
    chk(labels.includes(want), `order board has "${want}"`);
  }
  chk(
    !labels.some((l) => /Piko|Press/i.test(l)),
    'the order board omits the stages this order never had'
  );
  // 0092: there is no "With Manager" row after ANY stage, not just the last.
  // QA passing surfaces the piece back to the Floor Manager directly, so there
  // is no waiting state left for such a row to describe.
  chk(
    !labels.some((l) => /With Manager/i.test(l)),
    'no "With Manager after ..." row anywhere on the board'
  );
  // Embroidery is in-house, so it has no transit rows in front of it — the
  // delivery person has no part in the first stage at all.
  chk(
    !labels.includes('Handover to Embroidery - In Delivery') &&
      !labels.includes('In Pickup after Embroidery'),
    'stage 1 has no handover or pickup row — embroidery never leaves the building'
  );

  const total = rows
    .filter((r) => r.kind === 'stage')
    .reduce((n, r) => n + (r.count ?? 0), 0);
  chk(total === mine.length, `the per-stage counts add up to ${mine.length} repeats (got ${total})`);

  const withPhoto = rows.filter((r) => r.photo_url).length;
  chk(withPhoto > 0, `photos surface on the board (${withPhoto} row(s) carry one)`);

  const rb = await rpc('floor', 'fm_repeat_status_board', { p_order_id: orderId });
  chk(rb.ok, 'the floor manager can read the repeat board');
  const mineOnBoard = (rb.body ?? []).find((r) => r.repeat_id === subject.id);
  chk(!!mineOnBoard, 'the walked repeat appears on the repeat board');
  if (mineOnBoard) {
    chk(
      mineOnBoard.status_label === got[got.length - 1],
      `the board agrees with the walk (${mineOnBoard.status_label})`
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Visibility — nobody but the floor manager and the owner
// ---------------------------------------------------------------------------
const ownerBoard = await rpc('owner', 'fm_order_status_board', { p_order_id: orderId });
if (ownerBoard.status !== 404) {
  chk(ownerBoard.ok, 'the OWNER can read the status board');
}
for (const who of ['qa', 'store', 'delivery', 'order']) {
  const r = await rpc(who, 'fm_order_status_board', { p_order_id: orderId });
  const rr = await rpc(who, 'fm_repeat_status_board', { p_order_id: orderId });
  if (r.status === 404) {
    info(`${who}: board not in the database yet — visibility unproven until 0090 is applied`);
    break;
  }
  chk(!r.ok && !rr.ok, `${who} is refused both boards (${r.status}/${rr.status})`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
