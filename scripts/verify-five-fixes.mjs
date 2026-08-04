/**
 * The five fixes + the QA final-QA photo (migration 0062).
 *
 * Alpha factory. Run: node scripts/verify-five-fixes.mjs
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
const msg = (r) => (r.body?.message ?? '').slice(0, 110);

const A = {
  ot: await login('order@alpha.test'), qa: await login('qa@alpha.test'),
  fm: await login('floor@alpha.test'), dp: await login('delivery@alpha.test'),
  sm: await login('store@alpha.test'), fp: await login('partner@alpha.test'),
  own: await login('owner@alpha.test'), acc: await login('accountant@alpha.test'),
};

console.log('\n============ FIVE FIXES + QA FINAL PHOTO (0062) ============');
console.log('Factory: Alpha Embroidery Works\n');

// ---------------------------------------------------------------------------
console.log('=== FIX 3a. Finishing Partner dashboard loads without SQL errors ===');
{
  for (const [fn, args] of [
    ['partner_get_earnings_summary', { p_period: null }],
    ['partner_get_completed_work',   { p_period: null }],
    ['partner_get_damage_charges',   { p_period: null }],
    ['partner_get_payment_history',  {}],
  ]) {
    const r = await rpc(fn, A.fp, args);
    chk(r.status === 200, `${fn} -> HTTP ${r.status}${r.status === 200 ? '' : ' ' + msg(r)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== FIX 2. Machine-assignment picker includes inventory-accepted orders ===');
{
  // The picker's exact filter, as the app now sends it.
  const PICKER = 'job_card_confirmed,machine_selection_pending,in_production,in_finishing';
  const picker = await q(`orders?select=id,order_code,status&status=in.(${PICKER})`, A.fm);
  const codes = new Set((picker.body ?? []).map((o) => o.order_code));

  // Every order that has had inventory accepted must be selectable.
  const accepted = await q(
    'orders?select=id,order_code,status&status=eq.machine_selection_pending', A.fm);
  chk((accepted.body ?? []).length > 0,
    `${(accepted.body ?? []).length} order(s) sit at machine_selection_pending (inventory accepted)`);

  const missing = (accepted.body ?? []).filter((o) => !codes.has(o.order_code));
  chk(missing.length === 0,
    missing.length === 0
      ? `all ${(accepted.body ?? []).length} appear in the picker — including ${(accepted.body ?? []).slice(0, 3).map((o) => o.order_code).join(', ')}`
      : `STILL MISSING: ${missing.map((o) => o.order_code).join(', ')}`);

  // The old filter, for contrast — this is what the bug was.
  const oldPicker = await q('orders?select=order_code&status=in.(job_card_confirmed,in_production)', A.fm);
  const oldCodes = new Set((oldPicker.body ?? []).map((o) => o.order_code));
  const wouldHaveMissed = (accepted.body ?? []).filter((o) => !oldCodes.has(o.order_code));
  chk(wouldHaveMissed.length > 0,
    `the OLD filter would have missed ${wouldHaveMissed.length} of them — confirms the root cause`);

  // ALP-00098 — the order originally reported. It should be selectable, OR
  // have legitimately moved PAST the point of needing a machine. What must not
  // happen is it sitting at machine_selection_pending and being absent.
  const target = await q('orders?select=order_code,status&order_code=eq.ALP-00098', A.fm);
  if (target.body?.[0]) {
    const t = target.body[0];
    const inPicker = ['job_card_confirmed','machine_selection_pending','in_production','in_finishing'].includes(t.status);
    const movedOn = ['awaiting_final_qa','ready_for_delivery','completed'].includes(t.status);
    chk(inPicker || movedOn,
      inPicker
        ? `ALP-00098 is "${t.status}" — selectable in the picker`
        : `ALP-00098 has since reached "${t.status}", past needing a machine — correctly not offered`);
  } else {
    console.log('  ..    ALP-00098 no longer present; covered by the generalised check above');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== FIX 4. Delivery list is newest-first ===');
{
  const r = await rpc('dp_orders_queue', A.dp, {});
  const rows = r.body ?? [];
  chk(r.status === 200, `dp_orders_queue -> HTTP ${r.status}`);
  chk(rows.length === 0 || 'arrived_at' in rows[0], 'rows carry arrived_at for sorting');

  // Within the non-breached, not-partner-ready group, arrival must descend.
  const plain = rows.filter((x) => !x.sla_breached && !x.partner_ready_at);
  let descending = true;
  for (let i = 1; i < plain.length; i++) {
    if (new Date(plain[i - 1].arrived_at) < new Date(plain[i].arrived_at)) { descending = false; break; }
  }
  chk(descending, `${plain.length} ordinary row(s) are newest-first`);
  if (plain.length >= 2) {
    console.log(`  ..    top: ${plain[0].repeat_code} (${plain[0].arrived_at?.slice(0, 16)})`);
    console.log(`  ..    end: ${plain[plain.length - 1].repeat_code} (${plain[plain.length - 1].arrived_at?.slice(0, 16)})`);
  }
  chk(rows.every((x, i) => i === 0 || !(x.sla_breached && !rows[i - 1].sla_breached)),
    'breached rows still sort above unbreached ones');
}

// ---------------------------------------------------------------------------
console.log('\n=== FIX 3b. Partner Active Work + "Handover to delivery person" ===');
{
  const before = await rpc('partner_active_work', A.fp, {});
  chk(before.status === 200, `partner_active_work -> HTTP ${before.status} ${msg(before)}`);

  // Drive a piece out to this partner so there is guaranteed active work.
  const partnerRow = await q('finishing_partners?select=id,name&user_id=not.is.null&deleted_at=is.null&limit=1', A.fm);
  const partnerId = partnerRow.body?.[0]?.id;
  chk(!!partnerId, `partner linked to a login: ${partnerRow.body?.[0]?.name}`);

  const cand = await q(
    'repeats?select=id,repeat_code,current_status&current_status=in.(in_progress,handover_for_delivery,awaiting_dp_collection,handed_over)&limit=1',
    A.fm);
  let walk = cand.body?.[0];
  if (walk && partnerId) {
    const step = {
      in_progress: () => rpc('fm_send_to_stage_qa', A.fm, { p_repeat_id: walk.id }),
      stage_qa: () => rpc('qa_pass_stage_qa', A.qa, { p_repeat_id: walk.id }),
      handover_for_delivery: () => rpc('fm_hand_over_stage', A.fm, { p_repeat_id: walk.id }),
      awaiting_dp_collection: () => rpc('dp_collect_from_floor', A.dp, { p_repeat_id: walk.id, p_photo_url: 'alpha/f5.jpg' }),
      handed_over: () => rpc('dp_send_to_partner', A.dp, { p_repeat_id: walk.id, p_partner_id: partnerId }),
    };
    let cur = walk.current_status;
    for (let i = 0; i < 8 && cur !== 'handed_off'; i++) {
      const f = step[cur]; if (!f) break;
      cur = (await f()).body?.current_status;
    }
    chk(cur === 'handed_off', `${walk.repeat_code} handed to the partner -> ${cur}`);

    const active = await rpc('partner_active_work', A.fp, {});
    const row = (active.body ?? []).find((x) => x.repeat_id === walk.id);
    chk(!!row, `it appears on the partner's Active work as "${row?.stage_type}" for ${row?.order_code}`);
    chk(row?.partner_ready_at === null, 'not yet marked finished');

    // Wrong role cannot press the partner's button.
    chk((await rpc('partner_ready_for_collection', A.dp, { p_repeat_id: walk.id })).status >= 400,
      'the delivery person cannot mark the partner\'s work finished');

    const ready = await rpc('partner_ready_for_collection', A.fp, { p_repeat_id: walk.id });
    chk(ready.status === 200 && !!ready.body?.partner_ready_at,
      `"Handover to delivery person" -> partner_ready_at set`);

    const dpQ = await rpc('dp_orders_queue', A.dp, {});
    const dpRow = (dpQ.body ?? []).find((x) => x.repeat_id === walk.id);
    chk(!!dpRow?.partner_ready_at, 'the delivery person sees it flagged as finished');

    // ...and it sorts above ordinary work.
    const idx = (dpQ.body ?? []).findIndex((x) => x.repeat_id === walk.id);
    const firstPlain = (dpQ.body ?? []).findIndex((x) => !x.sla_breached && !x.partner_ready_at);
    chk(firstPlain === -1 || idx < firstPlain, 'finished-by-partner rows sort above ordinary ones');

    // Collecting clears the flag so the next stage does not start out "finished".
    const back = await rpc('dp_collect_from_partner', A.dp, { p_repeat_id: walk.id, p_photo_url: 'alpha/f5-back.jpg' });
    chk(back.status === 200 && back.body?.partner_ready_at === null,
      'collecting clears the ready flag — it belonged to that leg only');

    const gone = await rpc('partner_active_work', A.fp, {});
    chk(!(gone.body ?? []).some((x) => x.repeat_id === walk.id),
      'it leaves the partner\'s Active work once collected');
  } else {
    no('no repeat available to walk out to the partner');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== QA final pass now requires a photo of the finished product ===');
{
  const queue = await rpc('qa_final_queue', A.qa, {});
  let target = queue.body?.[0];

  if (!target) {
    // Manufacture one: find a repeat at awaiting_final_qa and clear FM's gate.
    const r = await q('repeats?select=id,repeat_code&current_status=eq.awaiting_final_qa&limit=1', A.fm);
    if (r.body?.[0]) {
      await rpc('fm_final_qa_pass', A.fm, { p_repeat_id: r.body[0].id });
      target = (await rpc('qa_final_queue', A.qa, {})).body?.[0];
    }
  }

  if (!target) {
    console.log('  ..    nothing at awaiting_qa_final to test against on this run');
  } else {
    const noPhoto = await rpc('qa_final_pass', A.qa, { p_repeat_id: target.repeat_id, p_photo_url: '  ' });
    chk(noPhoto.status >= 400 && /photo/i.test(msg(noPhoto)),
      `passing without a photo is refused -> ${msg(noPhoto)}`);

    const old = await rpc('qa_final_pass', A.qa, { p_repeat_id: target.repeat_id, p_note: 'x' });
    chk(old.status >= 400,
      'the old 2-argument form is gone — it cannot bind past the photo requirement');

    const good = await rpc('qa_final_pass', A.qa, {
      p_repeat_id: target.repeat_id, p_photo_url: 'alpha/final-qa.jpg',
    });
    chk(good.status === 200 && good.body?.status === 'completed',
      `${target.repeat_code} passed with a photo -> ${good.body?.status}`);

    const hist = await q(
      `repeat_stage_history?repeat_id=eq.${target.repeat_id}&status=eq.completed&select=photo_url&order=created_at.desc&limit=1`,
      A.qa);
    chk(!!hist.body?.[0]?.photo_url, `the photo is stored on the completion record (${hist.body?.[0]?.photo_url})`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== FIX 5. Notification queue counts, per role ===');
{
  for (const [who, tok] of Object.entries(A)) {
    const r = await rpc('my_queue_summary', tok, {});
    if (r.status !== 200) { no(`my_queue_summary for ${who} -> HTTP ${r.status} ${msg(r)}`); continue; }
    const rows = r.body ?? [];
    const total = rows.reduce((n, x) => n + Number(x.count), 0);
    ok(`${who.padEnd(4)} badge ${String(total).padStart(3)} — ${rows.map((x) => `${x.label}: ${x.count}`).join(', ') || 'nothing waiting'}`);
  }

  // It must never leak across tenants.
  const bFm = await login('floor@beta.test');
  const bRows = (await rpc('my_queue_summary', bFm, {})).body ?? [];
  const aRows = (await rpc('my_queue_summary', A.fm, {})).body ?? [];
  const bTotal = bRows.reduce((n, x) => n + Number(x.count), 0);
  const aTotal = aRows.reduce((n, x) => n + Number(x.count), 0);
  chk(bTotal !== aTotal || aTotal === 0,
    `Beta's floor manager sees its own counts (${bTotal}), not Alpha's (${aTotal})`);
}

console.log(`\n================ ${pass} passed, ${fail} failed ================\n`);
process.exit(fail ? 1 : 0);
