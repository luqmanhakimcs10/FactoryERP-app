/** Detail probe on the one stranded order + the paths that could still create one. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

async function login(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });
  return (await r.json().catch(() => null))?.access_token ?? null;
}
async function q(tok, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function rpc(tok, fn, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const fm = await login('floor@alpha.test');
const qa = await login('qa@alpha.test');
const OID = '791d941d-3c09-410a-bf5f-01aa1eb5e8e7';

console.log('=== ALP-00084 full detail ===');
const o = await q(fm, `orders?select=*&id=eq.${OID}`);
const ord = o.body?.[0];
console.log(`status=${ord?.status} machine=${ord?.assigned_machine_id} created=${ord?.created_at}`);

const dmg = await q(fm, `damage_records?select=*&order_id=eq.${OID}`);
for (const d of dmg.body ?? []) {
  console.log(`  damage ${d.id.slice(0, 8)} stage_type=${d.stage_type} recheck=${d.recheck_state} ` +
    `ot_confirmed=${d.ot_return_confirmed_at} repeat_id=${d.repeat_id} created=${d.created_at} type=${d.damage_type}`);
}

const stg = await q(fm, `order_stages?select=sequence,stage_type,is_outsourced&order_id=eq.${OID}&order=sequence`);
console.log(`  stages: ${JSON.stringify(stg.body)}`);

console.log('\n=== Can QA see it anywhere? ===');
for (const fn of ['qa_inspection_queue', 'qa_stage_tracking_queue', 'qa_final_queue']) {
  const r = await rpc(qa, fn, {});
  const hit = Array.isArray(r.body) ? r.body.filter((x) => x.order_id === OID) : null;
  console.log(`  ${fn} -> HTTP ${r.status}, rows for this order: ${hit ? hit.length : 'n/a'}`);
}

console.log('\n=== Does fm_start_production refuse a zero-repeat order TODAY? ===');
// It is already in_production, so this proves only the status guard. Instead:
const r = await rpc(fm, 'fm_start_production', { p_order_id: OID });
console.log(`  fm_start_production on the stranded order -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

console.log('\n=== Would the 0059 gate refuse it if it were sent back? ===');
const cnt = await rpc(fm, 'sheet_piece_counts', {
  p_sheet_id: (await q(fm, `sheets?select=id&order_id=eq.${OID}`)).body?.[0]?.id,
});
console.log(`  sheet_piece_counts -> ${JSON.stringify(cnt.body)}`);
console.log('  => coded=0 means qa_complete_repeat_qa raises "no passed pieces".');
console.log('  => and nothing sets written_off back to a live state, so awaiting_coding is a DEAD END for it.');

console.log('\n=== Stage tracking for it (the screen that showed "No repeats coded yet") ===');
const track = await rpc(fm, 'fm_stage_tracking', { p_order_id: OID });
console.log(`  fm_stage_tracking -> HTTP ${track.status}, rows ${Array.isArray(track.body) ? track.body.length : JSON.stringify(track.body).slice(0, 120)}`);
