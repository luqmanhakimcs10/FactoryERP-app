/**
 * Fix 0 — an order cannot reach production with zero coded repeats (0061).
 *
 * Two halves:
 *   A. The GUARD holds: an all-rejected order is refused at every step from the
 *      job card onward, and the repair left no order past the job card with
 *      zero repeats.
 *   B. A FRESH order walks the whole way — Incoming Inspection -> Repeat Coding
 *      -> Job Card -> Assign Machine -> Start Production — and Stage Tracking
 *      is genuinely populated at the end of it.
 *
 * Alpha factory only, per the brief.
 *
 * Run:  node scripts/verify-fix0-production-guard.mjs
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
  ot: await login('order@alpha.test'),
  qa: await login('qa@alpha.test'),
  fm: await login('floor@alpha.test'),
  dp: await login('delivery@alpha.test'),
  sm: await login('store@alpha.test'),
};

console.log('\n============ FIX 0 — production needs coded repeats (0061) ============');
console.log('Factory: Alpha Embroidery Works\n');

// The job card generates one needle line per thread colour on the order, so an
// order created without colours can never produce one — which would stall this
// walk for a reason that has nothing to do with Fix 0. Use real Alpha stock.
const THREADS = ((await q('thread_stock?select=color_code&limit=2', A.fm)).body ?? [])
  .map((t) => t.color_code);
if (THREADS.length === 0) {
  console.log('No thread stock in Alpha — a job card cannot be built. Stopping.');
  process.exit(1);
}
console.log(`Thread colours for the walk: ${THREADS.join(', ')}\n`);

// ---------------------------------------------------------------------------
// 1. The repair: nothing past the job card is left empty.
// ---------------------------------------------------------------------------
console.log('=== 1. Existing data repaired ===');
{
  const past = await q(
    'orders?select=id,order_code,status&status=in.(awaiting_job_card,job_card_shared,job_card_confirmed,machine_selection_pending,in_production,in_finishing,awaiting_final_qa,ready_for_delivery)',
    A.fm);
  let empty = [];
  for (const o of past.body ?? []) {
    const r = await q(`repeats?select=id&sheets.order_id=eq.${o.id}&select=id,sheets!inner(order_id)`, A.fm);
    if ((r.body ?? []).length === 0) empty.push(`${o.order_code} (${o.status})`);
  }
  chk(empty.length === 0,
    empty.length === 0
      ? `no order past the job card has zero repeats (checked ${past.body?.length ?? 0})`
      : `STILL BROKEN: ${empty.join(', ')}`);

  const healed = await q('orders?select=order_code,status&order_code=eq.ALP-00084', A.fm);
  chk(healed.body?.[0]?.status === 'awaiting_coding',
    `ALP-00084 (the reported order) is back at "${healed.body?.[0]?.status}" — honest about QA being unfinished`);
}

// ---------------------------------------------------------------------------
// 2. An all-rejected order can never reach the job card OR production.
//
// This asserts the OUTCOME, not one internal guard. The early
// `fm_set_stage_sequence` check is unreachable through normal use now, because
// 0059 already stops an all-rejected order at `awaiting_coding` — it never
// reaches a status where a stage sequence could be set. That is exactly what
// defence in depth looks like: the outer gate makes the inner one redundant,
// and both stay so a future path cannot slip between them.
// ---------------------------------------------------------------------------
console.log('\n=== 2. An all-rejected order can never reach the job card OR production ===');
{
  const vendor = (await q('vendors?select=id&deleted_at=is.null&limit=1', A.ot)).body?.[0];
  const made = await rpc('create_order', A.ot, {
    p_vendor_id: vendor.id,
    p_sheets: [{ sheet_number: 1, color_assignment: 'Fix0 AllReject', repeats_count: 2,
                 stitch_count: 4000, thread_color_codes: THREADS }],
    p_cloth_photos: ['alpha/fix0-ar.jpg'], p_design_sheet_url: 'alpha/fix0-ar-d.jpg',
  });
  const bad = made.body;
  await rpc('submit_order', A.ot, { p_order_id: bad.id });
  let st = (await q(`orders?id=eq.${bad.id}&select=status`, A.qa)).body?.[0]?.status;
  if (st === 'awaiting_cloth_inspection') {
    await rpc('qa_accept_cloth', A.qa, { p_order_id: bad.id });
    st = (await q(`orders?id=eq.${bad.id}&select=status`, A.qa)).body?.[0]?.status;
  }

  if (st !== 'awaiting_coding') {
    console.log(`  ..    ${bad.order_code} sits at "${st}" — cannot probe coding on this run`);
  } else {
    const sheet = (await q(`sheets?select=id&order_id=eq.${bad.id}`, A.qa)).body?.[0];
    const rej = await rpc('qa_reject_piece', A.qa, {
      p_order_id: bad.id, p_sheet_id: sheet.id, p_damage_type: 'fabric',
      p_photo_url: 'alpha/fix0-ar-rej.jpg', p_scope: 'sheet',
    });
    chk(rej.status === 200, `${bad.order_code}: EVERY piece rejected (${rej.body?.count} of them)`);

    const cont = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: bad.id });
    chk(cont.status >= 400, `"Continue to job card" refused -> ${msg(cont)}`);

    const seq = await rpc('fm_set_stage_sequence', A.fm, {
      p_order_id: bad.id, p_stages: [{ stage_type: 'embroidery', is_outsourced: false, sla_hours: 24 }],
    });
    chk(seq.status >= 400, `job card build refused -> ${msg(seq)}`);

    const start = await rpc('fm_start_production', A.fm, { p_order_id: bad.id });
    chk(start.status >= 400, `Start Production refused -> ${msg(start)}`);

    const now = (await q(`orders?id=eq.${bad.id}&select=status`, A.fm)).body?.[0]?.status;
    chk(now === 'awaiting_coding',
      `${bad.order_code} is stuck at "${now}" — where an order with nothing usable belongs`);

    const reps = await q(`repeats?select=id,sheets!inner(order_id)&sheets.order_id=eq.${bad.id}`, A.fm);
    chk((reps.body ?? []).length === 0, 'it still has zero repeats, and cannot advance with zero');
  }
}

// ---------------------------------------------------------------------------
// 3. A FRESH order walks the whole way and Stage Tracking populates.
// ---------------------------------------------------------------------------
console.log('\n=== 3. Fresh order: Inspection -> Coding -> Job Card -> Start Production ===');
let FRESH = null;
{
  const vendor = (await q('vendors?select=id,name&deleted_at=is.null&limit=1', A.ot)).body?.[0];
  const created = await rpc('create_order', A.ot, {
    p_vendor_id: vendor.id,
    p_sheets: [{ sheet_number: 1, color_assignment: 'Fix0 Walk', repeats_count: 2,
                 stitch_count: 5000, thread_color_codes: THREADS }],
    p_cloth_photos: ['alpha/fix0-cloth.jpg'],
    p_design_sheet_url: 'alpha/fix0-design.jpg',
  });
  chk(created.status === 200 && !!created.body?.id, `created ${created.body?.order_code} for ${vendor.name}`);
  FRESH = created.body;

  const submitted = await rpc('submit_order', A.ot, { p_order_id: FRESH.id });
  console.log(`  ..    submitted -> "${submitted.body?.status ?? submitted.body}"`);

  // Procurement/stock may divert it; push it to inspection the sanctioned way.
  let cur = (await q(`orders?id=eq.${FRESH.id}&select=status`, A.ot)).body?.[0]?.status;
  if (cur === 'awaiting_procurement') {
    console.log('  ..    order needs thread — issuing material so it can reach inspection');
    const iss = await rpc('sm_auto_issue_for_order', A.sm, { p_order_id: FRESH.id }).catch(() => null);
    cur = (await q(`orders?id=eq.${FRESH.id}&select=status`, A.ot)).body?.[0]?.status;
  }
  chk(cur === 'awaiting_cloth_inspection' || cur === 'awaiting_coding',
    `order is at "${cur}" — ready for Initial QA`);

  if (cur === 'awaiting_cloth_inspection') {
    const insp = await rpc('qa_accept_cloth', A.qa, { p_order_id: FRESH.id });
    chk(insp.status === 200, `cloth inspection accepted -> ${insp.body?.status ?? insp.status}`);
  }
}

// ---- Repeat coding: this is the step that was being skipped ----
{
  const sheet = (await q(`sheets?select=id,repeats_count&order_id=eq.${FRESH.id}`, A.qa)).body?.[0];

  // Reject one, pass one — proves a partially-rejected order still works, and
  // that the rejected piece blocks until it has been round-tripped.
  const rej = await rpc('qa_reject_piece', A.qa, {
    p_order_id: FRESH.id, p_sheet_id: sheet.id, p_damage_type: 'fabric',
    p_photo_url: 'alpha/fix0-reject.jpg', p_scope: 'piece',
  });
  const damageId = rej.body?.damage_ids?.[0];
  chk(rej.status === 200, 'piece 1 rejected at Initial QA');

  const p1 = await rpc('qa_pass_piece', A.qa, {
    p_order_id: FRESH.id, p_sheet_id: sheet.id, p_photo_url: 'alpha/fix0-pass.jpg',
  });
  chk(p1.status === 200 && !!p1.body?.repeat_code, `piece 2 PASSED -> coded ${p1.body?.repeat_code}`);

  const blocked = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: FRESH.id });
  chk(blocked.status >= 400, `job card still blocked while piece 1 is out -> ${msg(blocked)}`);

  // Round-trip the rejected piece (0059) and pass it.
  await rpc('ot_complete_qa_return', A.ot, { p_damage_id: damageId, p_photo_url: 'alpha/fix0-handback.jpg' });
  const re = await rpc('qa_recheck_piece', A.qa, {
    p_damage_id: damageId, p_pass: true, p_photo_url: 'alpha/fix0-repass.jpg',
  });
  chk(re.status === 200 && re.body?.outcome === 'passed',
    `piece 1 returned and re-passed -> coded ${re.body?.repeat_code}`);

  const go = await rpc('qa_complete_repeat_qa', A.qa, { p_order_id: FRESH.id });
  chk(go.status === 200 && go.body?.status === 'awaiting_job_card',
    `Repeat Coding complete -> "${go.body?.status}"`);

  const reps = await q(`repeats?select=id,repeat_code,current_status,sheets!inner(order_id)&sheets.order_id=eq.${FRESH.id}`, A.qa);
  chk((reps.body ?? []).length === 2,
    `${(reps.body ?? []).length} coded repeat(s): ${(reps.body ?? []).map((r) => r.repeat_code).join(', ')}`);
}

// ---- Job card ----
{
  const seq = await rpc('fm_set_stage_sequence', A.fm, {
    p_order_id: FRESH.id,
    p_stages: [
      { stage_type: 'embroidery', is_outsourced: false, sla_hours: 24 },
      { stage_type: 'clipping', is_outsourced: true, sla_hours: 24 },
    ],
  });
  chk(seq.status === 200 && seq.body?.stages === 2,
    `stage sequence set (${seq.body?.stages} stages) — the guard let it through now repeats exist`);

  const gen = await rpc('fm_generate_job_card', A.fm, { p_order_id: FRESH.id });
  chk(gen.status === 200, `job card generated -> HTTP ${gen.status} ${msg(gen)}`);
  const shared = await rpc('fm_share_job_card', A.fm, { p_order_id: FRESH.id });
  chk(shared.status < 400, `job card shared -> HTTP ${shared.status}`);
  // 0050: marking the vendor informed is what CONFIRMS the card.
  const informed = await rpc('fm_mark_vendor_informed', A.fm, { p_order_id: FRESH.id });
  chk(informed.status < 400, `vendor informed (confirms the card) -> HTTP ${informed.status} ${msg(informed)}`);
  const asked = await rpc('fm_ask_for_material', A.fm, { p_order_id: FRESH.id });
  console.log(`  ..    asked the store for material -> HTTP ${asked.status}`);
  const st = (await q(`orders?id=eq.${FRESH.id}&select=status`, A.fm)).body?.[0]?.status;
  console.log(`  ..    order is at "${st}"`);
}

// ---- Machine + Start Production ----
{
  // Get it to machine_selection_pending via the material-acceptance path.
  let st = (await q(`orders?id=eq.${FRESH.id}&select=status`, A.fm)).body?.[0]?.status;
  if (st === 'job_card_confirmed') {
    // The store manager issues the thread against the job card, then the floor
    // manager accepts it — that acceptance is what opens machine selection.
    const card = (await q(`job_cards?select=id&order_id=eq.${FRESH.id}`, A.sm)).body?.[0];
    const issued = await rpc('sm_issue_materials', A.sm, { p_job_card_id: card?.id, p_note: 'fix0 walk' });
    chk(issued.status === 200, `store issued materials -> ${issued.body?.issue_code ?? msg(issued)}`);

    const iss = await q(`material_issues?select=id&order_id=eq.${FRESH.id}&accepted_at=is.null`, A.fm);
    if (iss.body?.[0]) {
      const acc = await rpc('fm_accept_inventory', A.fm, {
        p_material_issue_id: iss.body[0].id, p_photo_url: 'alpha/fix0-material.jpg',
      });
      chk(acc.status === 200, `floor manager accepted the materials -> HTTP ${acc.status} ${msg(acc)}`);
    }
    st = (await q(`orders?id=eq.${FRESH.id}&select=status`, A.fm)).body?.[0]?.status;
  }
  chk(st === 'machine_selection_pending', `order reached "${st}"`);

  if (st === 'machine_selection_pending') {
    const machine = (await rpc('fm_list_machines', A.fm, {})).body?.[0];
    const worker = (await rpc('list_factory_workers', A.fm, {})).body?.[0];

    const assigned = await rpc('fm_assign_machine_with_shift', A.fm, {
      p_order_id: FRESH.id, p_machine_id: machine.id, p_worker_id: worker.id,
      p_worker_photo_url: 'alpha/fix0-worker.jpg',
      p_open_photo_url: 'alpha/fix0-panel.jpg', p_open_stitches: 100,
    });
    chk(assigned.status === 200,
      `Assign Machine (one action: machine + worker + photo + time) -> shift ${String(assigned.body?.shift_id).slice(0, 8)}`);

    const started = await rpc('fm_start_production', A.fm, { p_order_id: FRESH.id });
    chk(started.status === 200 && started.body?.status === 'in_production',
      `Start Production -> "${started.body?.status}", ${started.body?.repeats_advanced} of ${started.body?.repeats_total} repeats advanced`);
    chk(started.body?.repeats_advanced === 2,
      'BOTH repeats entered the loop — none stranded');
  }
}

// ---- Stage Tracking is actually populated ----
console.log('\n=== 4. Stage Tracking populates (the thing that was empty) ===');
{
  const reps = await q(
    `repeats?select=repeat_code,current_status,current_stage_index,sheets!inner(order_id)&sheets.order_id=eq.${FRESH.id}&order=repeat_code`,
    A.fm);
  const rows = reps.body ?? [];
  chk(rows.length > 0, `Stage Tracking shows ${rows.length} repeat(s) — NOT "No repeats coded yet"`);
  chk(rows.every((r) => r.current_status === 'in_progress' && r.current_stage_index === 1),
    `every repeat is In Progress on stage 1: ${rows.map((r) => `${r.repeat_code}=${r.current_status}`).join(', ')}`);

  const stages = await q(`order_stages?select=sequence,stage_type&order_id=eq.${FRESH.id}&order=sequence`, A.fm);
  console.log(`  ..    stage sequence: ${(stages.body ?? []).map((s) => `${s.sequence}.${s.stage_type}`).join(' -> ')}`);
}

console.log(`\n================ ${pass} passed, ${fail} failed ================`);
console.log(`Fresh order used: ${FRESH?.order_code}\n`);
process.exit(fail ? 1 : 0);
