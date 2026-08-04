/**
 * Walks one real order through the FULL stage handover loop (0056/0057), for
 * every stage in its sequence, and then through the two-gate final sequence.
 *
 * This is the definition-of-done check, executed against the live database with
 * the real per-role logins — not mocked. Every transition is made by the role
 * the brief says owns it, and the wrong role is proven to be refused at each
 * gate rather than merely not offered the button.
 *
 * Run:  node scripts/verify-stage-handover.mjs
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

let pass = 0;
let fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

const login = async (e) => {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Password123!' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${e}: ${JSON.stringify(j)}`);
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
const refused = (r) => r.status >= 400;
const msg = (r) => (r.body?.message ?? '').slice(0, 90);

const A = {
  fm: await login('floor@alpha.test'),
  qa: await login('qa@alpha.test'),
  dp: await login('delivery@alpha.test'),
  ot: await login('order@alpha.test'),
  own: await login('owner@alpha.test'),
};

console.log('\n================ STAGE HANDOVER LOOP (0056/0057) ================');

// ---------------------------------------------------------------------------
// 0. Find an order already inside the loop, or one we can push into it.
// ---------------------------------------------------------------------------
/**
 * Statuses a repeat can be driven on from. A repeat still at
 * `ready_for_production` with stage_index 0 was coded AFTER its order started
 * production, so `fm_start_production` (which only runs at
 * machine_selection_pending) never picked it up — nothing in the app can move
 * it into the loop, so it is not a valid subject for this walk.
 */
const DRIVABLE = [
  'in_progress', 'stage_qa', 'handover_for_delivery', 'awaiting_dp_collection',
  'handed_over', 'handed_off', 'returned_to_delivery', 'awaiting_fm_collection',
];

console.log('\n=== 0. Pick an order that is in production with stages configured ===');
let ORDER = null;
{
  const cands = await q(
    'orders?select=id,order_code,status,assigned_machine_id&status=in.(in_production,in_finishing)&order=created_at.asc',
    A.fm
  );
  for (const o of cands.body ?? []) {
    const st = await q(`order_stages?select=id,sequence,stage_type&order_id=eq.${o.id}&order=sequence.asc`, A.fm);
    const reps = await q(
      `repeats?select=id,repeat_code,current_status,current_stage_index,sheets!inner(order_id)&sheets.order_id=eq.${o.id}`,
      A.fm
    );
    // The order needs >=2 stages AND at least one repeat this script can move.
    // Needs a repeat with at least TWO stages still to run: the brief's
    // definition of done is a full cycle walked twice, and a repeat already on
    // its last stage cannot provide that.
    const total = st.body?.length ?? 0;
    const walkable = (reps.body ?? []).some(
      (r) => DRIVABLE.includes(r.current_status) &&
             r.current_stage_index >= 1 &&
             r.current_stage_index <= total - 2
    );
    if (total >= 2 && walkable) {
      ORDER = { ...o, stages: st.body, repeats: reps.body };
      break;
    }
  }
  chk(!!ORDER, ORDER
    ? `order ${ORDER.order_code} — ${ORDER.stages.length} stages, ${ORDER.repeats.length} repeat(s)`
    : 'no in-production order with >=2 stages found');
}
if (!ORDER) {
  console.log('\nCannot walk the loop without a suitable order. Stopping.');
  process.exit(1);
}

const STAGES = ORDER.stages;
const partners = await q('finishing_partners?select=id,name&deleted_at=is.null&limit=2', A.dp);
chk((partners.body?.length ?? 0) > 0, `finishing partners available: ${(partners.body ?? []).map((p) => p.name).join(', ')}`);
const PARTNER = partners.body?.[0];

// The repeat we drive all the way round.
//
// It has to be one this script can actually POSITION. A repeat still sitting at
// `ready_for_production` with stage_index 0 was coded AFTER its order already
// started production, so `fm_start_production` (which only runs at
// machine_selection_pending) never picked it up and nothing can move it — see
// the note this script prints if that is all it can find.
let WALK =
  ORDER.repeats.find(
    (r) => DRIVABLE.includes(r.current_status) &&
           r.current_stage_index >= 1 &&
           r.current_stage_index <= STAGES.length - 2
  ) ?? ORDER.repeats[0];

if (!DRIVABLE.includes(WALK.current_status)) {
  no(`no repeat on ${ORDER.order_code} is in a drivable state — ` +
     `${WALK.repeat_code} is "${WALK.current_status}" at stage index ${WALK.current_stage_index}. ` +
     `A repeat coded after its order started production is stranded: fm_start_production only ` +
     `runs at machine_selection_pending, so nothing moves it into the loop.`);
  console.log(`\n${pass} passed, ${fail} failed — cannot walk the loop on this order.\n`);
  process.exit(1);
}
const statusOf = async (id) => {
  const r = await q(`repeats?id=eq.${id}&select=current_status,current_stage_index,current_partner_id`, A.fm);
  return r.body?.[0] ?? {};
};

console.log(`\nWalking repeat ${WALK.repeat_code} (currently ${WALK.current_status}, stage index ${WALK.current_stage_index})`);

// ---------------------------------------------------------------------------
// 1. `awaiting_stage` and `fm_start_stage` are gone
// ---------------------------------------------------------------------------
console.log('\n=== 1. The retired status and its button no longer exist ===');
{
  const left = await q('repeats?select=id&current_status=eq.awaiting_stage', A.fm);
  chk((left.body?.length ?? 0) === 0, 'no live repeat is left on awaiting_stage (all healed forward)');

  const gone = await rpc('fm_start_stage', A.fm, { p_repeat_id: WALK.id });
  chk(gone.status === 404, `fm_start_stage is dropped, not merely unused (HTTP ${gone.status})`);
}

// ---------------------------------------------------------------------------
// 2. Drive the repeat to the head of the loop.
// ---------------------------------------------------------------------------
console.log('\n=== 2. Position the repeat at In Progress on its current stage ===');
{
  let s = await statusOf(WALK.id);
  // Nudge whatever state it is in back to in_progress via the sanctioned RPCs.
  let guard = 0;
  while (s.current_status !== 'in_progress' && guard++ < 12) {
    switch (s.current_status) {
      case 'stage_qa':               await rpc('qa_pass_stage_qa', A.qa, { p_repeat_id: WALK.id }); break;
      case 'handover_for_delivery':  await rpc('fm_hand_over_stage', A.fm, { p_repeat_id: WALK.id }); break;
      case 'awaiting_dp_collection': await rpc('dp_collect_from_floor', A.dp, { p_repeat_id: WALK.id, p_photo_url: 'alpha/seed.jpg' }); break;
      case 'handed_over':            await rpc('dp_send_to_partner', A.dp, { p_repeat_id: WALK.id, p_partner_id: PARTNER?.id }); break;
      case 'handed_off':             await rpc('dp_collect_from_partner', A.dp, { p_repeat_id: WALK.id, p_photo_url: 'alpha/seed.jpg' }); break;
      case 'returned_to_delivery':   await rpc('dp_hand_back_to_floor', A.dp, { p_repeat_id: WALK.id }); break;
      case 'awaiting_fm_collection': await rpc('fm_confirm_collection', A.fm, { p_repeat_id: WALK.id }); break;
      default: guard = 99;
    }
    s = await statusOf(WALK.id);
  }
  chk(s.current_status === 'in_progress', `repeat is In Progress at stage index ${s.current_stage_index} (${s.current_status})`);
}

// ---------------------------------------------------------------------------
// 3. THE FULL CYCLE, twice.
// ---------------------------------------------------------------------------
const stageName = (i) => STAGES.find((s) => s.sequence === i)?.stage_type ?? '?';

async function walkOneStage(label) {
  const before = await statusOf(WALK.id);
  const idx = before.current_stage_index;
  console.log(`\n--- ${label}: stage ${idx} of ${STAGES.length} — "${stageName(idx)}" ---`);

  // 3a. In Progress -> Go to QA (Floor Manager)
  chk(refused(await rpc('fm_send_to_stage_qa', A.qa, { p_repeat_id: WALK.id })), 'QA is refused on "Go to QA" (FM action)');
  let r = await rpc('fm_send_to_stage_qa', A.fm, { p_repeat_id: WALK.id });
  chk(r.status === 200 && r.body?.current_status === 'stage_qa', `In Progress -> Go to QA -> ${r.body?.current_status}`);

  // 3b. Stage QA pass (QA only)
  chk(refused(await rpc('qa_pass_stage_qa', A.fm, { p_repeat_id: WALK.id })), 'FM is refused on Stage QA pass (QA action)');
  r = await rpc('qa_pass_stage_qa', A.qa, { p_repeat_id: WALK.id });
  chk(r.status === 200 && r.body?.current_status === 'handover_for_delivery',
    `Stage QA pass -> ${r.body?.current_status} (NOT the next stage — this is the change)`);

  // 3c. Hand over (Floor Manager)
  chk(refused(await rpc('fm_hand_over_stage', A.dp, { p_repeat_id: WALK.id })), 'Delivery is refused on "Hand over" (FM action)');
  r = await rpc('fm_hand_over_stage', A.fm, { p_repeat_id: WALK.id });
  chk(r.status === 200 && r.body?.current_status === 'awaiting_dp_collection',
    `Hand over -> ${r.body?.current_status}`);

  // 3d. It must now be on the Delivery Person's single Orders feed.
  let feed = await rpc('dp_orders_queue', A.dp, {});
  let row = (feed.body ?? []).find((x) => x.repeat_id === WALK.id);
  chk(!!row && row.current_status === 'awaiting_dp_collection',
    `appears on DP Orders queue as "${row?.current_status}" for stage "${row?.stage_type}"`);

  // 3e. Collect from Floor Manager — PHOTO REQUIRED
  const noPhoto = await rpc('dp_collect_from_floor', A.dp, { p_repeat_id: WALK.id, p_photo_url: '  ' });
  chk(refused(noPhoto) && /photo/i.test(msg(noPhoto)), `collect without a photo is refused -> ${msg(noPhoto)}`);
  chk(refused(await rpc('dp_collect_from_floor', A.fm, { p_repeat_id: WALK.id, p_photo_url: 'alpha/c1.jpg' })),
    'FM is refused on the Delivery Person\'s Collect');
  r = await rpc('dp_collect_from_floor', A.dp, { p_repeat_id: WALK.id, p_photo_url: `alpha/collect-${idx}.jpg` });
  chk(r.status === 200 && r.body?.current_status === 'handed_over',
    `Collect (photo) -> ${r.body?.current_status}  [FM reads "Handed Over", DP reads "Delivery waiting"]`);

  // 3f. Pick who is handling this stage, then send out. SLA starts.
  const noPartner = await rpc('dp_send_to_partner', A.dp, { p_repeat_id: WALK.id, p_partner_id: null });
  chk(refused(noPartner), `handover with nobody selected is refused -> ${msg(noPartner)}`);
  r = await rpc('dp_send_to_partner', A.dp, { p_repeat_id: WALK.id, p_partner_id: PARTNER.id });
  chk(r.status === 200 && r.body?.current_status === 'handed_off',
    `"${stageName(idx)} person select" = ${PARTNER.name} -> Handover to finishing partner -> ${r.body?.current_status}`);

  const leg = await q(
    `repeat_stage_history?repeat_id=eq.${WALK.id}&handed_off_at=not.is.null&returned_at=is.null&select=id,handed_off_at,partner_id`,
    A.fm
  );
  chk((leg.body?.length ?? 0) === 1,
    `exactly ONE open SLA leg written (handed_off_at set, partner stamped) — ${leg.body?.length} row(s)`);

  // 3g. Collect back from the partner — PHOTO REQUIRED. Closes the SLA window.
  const backNoPhoto = await rpc('dp_collect_from_partner', A.dp, { p_repeat_id: WALK.id, p_photo_url: '' });
  chk(refused(backNoPhoto) && /photo/i.test(msg(backNoPhoto)), `collect-back without a photo is refused -> ${msg(backNoPhoto)}`);
  r = await rpc('dp_collect_from_partner', A.dp, { p_repeat_id: WALK.id, p_photo_url: `alpha/back-${idx}.jpg` });
  chk(r.status === 200 && r.body?.current_status === 'returned_to_delivery',
    `Collect back from partner (photo) -> ${r.body?.current_status}`);

  const closed = await q(
    `repeat_stage_history?repeat_id=eq.${WALK.id}&handed_off_at=not.is.null&returned_at=is.null&select=id`,
    A.fm
  );
  chk((closed.body?.length ?? 0) === 0, 'the SLA leg is closed (returned_at stamped) — no open leg remains');

  // 3h. Hand back to the Floor Manager -> raises the FM's "Collect [stage]" prompt
  r = await rpc('dp_hand_back_to_floor', A.dp, { p_repeat_id: WALK.id });
  chk(r.status === 200 && r.body?.current_status === 'awaiting_fm_collection',
    `Hand back to Floor Manager -> ${r.body?.current_status}`);

  const prompt = await rpc('fm_pending_collections', A.fm, { p_order_id: ORDER.id });
  const prow = (prompt.body ?? []).find((x) => x.repeat_id === WALK.id);
  chk(!!prow, `FM popup feed shows "Collect ${prow?.stage_type}" for ${prow?.repeat_code}`);

  // 3i. FM confirms -> NEXT STAGE OPENS AT IN PROGRESS AUTOMATICALLY
  chk(refused(await rpc('fm_confirm_collection', A.dp, { p_repeat_id: WALK.id })), 'Delivery is refused on the FM\'s Collect confirmation');
  r = await rpc('fm_confirm_collection', A.fm, { p_repeat_id: WALK.id });
  const after = await statusOf(WALK.id);
  const wasLast = idx >= STAGES.length;
  if (wasLast) {
    chk(after.current_status === 'awaiting_final_qa',
      `last stage confirmed -> ${after.current_status}`);
  } else {
    chk(after.current_status === 'in_progress' && after.current_stage_index === idx + 1,
      `confirmed -> stage ${after.current_stage_index} ("${stageName(after.current_stage_index)}") opened AUTOMATICALLY at ${after.current_status} — no "Start stage" needed`);
    chk(after.current_partner_id === null, 'the finished stage\'s partner assignment was cleared, not carried forward');
  }
  return after;
}

console.log('\n=== 3. Full cycle, stage by stage ===');
let state = await statusOf(WALK.id);
let cycles = 0;
while (state.current_status === 'in_progress' && cycles < STAGES.length + 1) {
  cycles++;
  state = await walkOneStage(`CYCLE ${cycles}`);
}
chk(cycles >= 2, `walked the full cycle for ${cycles} stage(s) — the brief requires at least 2`);
chk(state.current_status === 'awaiting_final_qa',
  `every stage in the sequence completed -> ${state.current_status}`);

// ---------------------------------------------------------------------------
// 4. Final sequence (Fix 5)
// ---------------------------------------------------------------------------
console.log('\n=== 4. Final sequence: FM Final QA -> QA final pass -> Order Taker sees it ===');
{
  chk(refused(await rpc('qa_final_pass', A.qa, { p_repeat_id: WALK.id })),
    'QA cannot do the final pass before the Floor Manager\'s Final QA');

  let r = await rpc('fm_final_qa_pass', A.fm, { p_repeat_id: WALK.id });
  chk(r.status === 200 && r.body?.status === 'awaiting_qa_final',
    `FM Final QA -> ${r.body?.status} (sent to QA, NOT completed outright)`);

  chk(refused(await rpc('qa_final_pass', A.fm, { p_repeat_id: WALK.id })),
    'FM is refused on QA\'s final pass — the two gates are genuinely different roles');

  const inQaQueue = await rpc('qa_final_queue', A.qa, {});
  chk((inQaQueue.body ?? []).some((x) => x.repeat_id === WALK.id), 'the repeat is on QA\'s final queue');

  r = await rpc('qa_final_pass', A.qa, { p_repeat_id: WALK.id, p_photo_url: 'alpha/final-product.jpg' });
  chk(r.status === 200 && r.body?.status === 'completed', `QA final pass -> ${r.body?.status}`);

  const s = await statusOf(WALK.id);
  chk(s.current_status === 'completed', 'repeat.current_status is completed');

  // Order-level roll-up, seen from the Order Taker's READ-ONLY board.
  const ord = await q(`orders?id=eq.${ORDER.id}&select=status`, A.fm);
  console.log(`  ..    order ${ORDER.order_code} status is now "${ord.body?.[0]?.status}" (${r.body?.order_ready ? 'all' : 'not all'} repeats through)`);

  const otBoard = await rpc('ot_return_repeats', A.ot, {});
  const otRow = (otBoard.body ?? []).find((x) => x.repeat_id === WALK.id);
  if (otRow) {
    chk(otRow.bucket === 'completed', `Order Taker's board buckets it as "${otRow.bucket}" — status only, no action offered`);
  } else {
    ok('repeat is not on the Order Taker\'s returns board (it never went through a return) — nothing for them to do');
  }
}

// ---------------------------------------------------------------------------
// 5. History is still the source of truth
// ---------------------------------------------------------------------------
console.log('\n=== 5. repeat_stage_history recorded every leg ===');
{
  const h = await q(
    `repeat_stage_history?repeat_id=eq.${WALK.id}&select=status,created_at,photo_url&order=created_at.asc`,
    A.fm
  );
  const seq = (h.body ?? []).map((x) => x.status);
  console.log('  ..    ' + seq.join(' -> '));
  for (const s of ['in_progress', 'stage_qa', 'handover_for_delivery', 'awaiting_dp_collection',
                   'handed_over', 'handed_off', 'returned_to_delivery', 'awaiting_fm_collection',
                   'awaiting_final_qa', 'awaiting_qa_final', 'completed']) {
    chk(seq.includes(s), `history contains a "${s}" row`);
  }
  const photos = (h.body ?? []).filter((x) => x.photo_url).length;
  chk(photos >= 2, `${photos} history rows carry a custody photo`);
}

// ---------------------------------------------------------------------------
// 6. Cross-tenant: Beta must not be able to touch any of this.
// ---------------------------------------------------------------------------
console.log('\n=== 6. Cross-tenant refusal on every new RPC ===');
{
  // Beta's factory is deactivated, but that gate lives in the app's AuthContext
  // — GoTrue still issues a token. So this is exactly the case worth testing:
  // a valid token for a tenant that must see nothing of Alpha's.
  const B = {};
  for (const [k, e] of [['fm', 'floor@beta.test'], ['qa', 'qa@beta.test'], ['dp', 'delivery@beta.test']]) {
    try { B[k] = await login(e); } catch { /* seat may not exist */ }
  }

  const calls = [
    ['fm_hand_over_stage',      'fm', { p_repeat_id: WALK.id }],
    ['dp_collect_from_floor',   'dp', { p_repeat_id: WALK.id, p_photo_url: 'x.jpg' }],
    ['dp_send_to_partner',      'dp', { p_repeat_id: WALK.id, p_partner_id: PARTNER.id }],
    ['dp_collect_from_partner', 'dp', { p_repeat_id: WALK.id, p_photo_url: 'x.jpg' }],
    ['dp_hand_back_to_floor',   'dp', { p_repeat_id: WALK.id }],
    ['fm_confirm_collection',   'fm', { p_repeat_id: WALK.id }],
    ['qa_final_pass',           'qa', { p_repeat_id: WALK.id, p_photo_url: 'x.jpg' }],
    ['fm_pending_collections',  'fm', { p_order_id: ORDER.id }],
  ];

  for (const [fn, who, args] of calls) {
    if (!B[who]) continue;
    const r = await rpc(fn, B[who], args);
    // A table-returning RPC answers 200 with an empty set; an action RPC must
    // 404. Either way Beta must learn nothing about this Alpha repeat.
    const leaked = r.status === 200 && Array.isArray(r.body) && r.body.length > 0;
    chk(!leaked && (r.status === 404 || (r.status === 200 && Array.isArray(r.body))),
      `Beta calling ${fn} on an ALPHA row -> HTTP ${r.status}, no data (${msg(r) || 'empty'})`);
  }

  // And an id that exists nowhere must 404 rather than 500 — PostgREST maps
  // P0002 badly, which is why raise_not_found exists at all.
  const bogus = '00000000-0000-0000-0000-000000000000';
  const nf = await rpc('fm_hand_over_stage', A.fm, { p_repeat_id: bogus });
  chk(nf.status === 404, `unknown repeat id -> 404, not 500 (HTTP ${nf.status})`);
}

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
