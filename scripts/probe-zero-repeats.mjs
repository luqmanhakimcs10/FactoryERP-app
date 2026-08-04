/**
 * Throwaway probe for Fix 0: how does an order reach production with no coded
 * repeats? Enumerates every order past the job-card gate and reports how many
 * repeats each actually has, plus which gate let the empty ones through.
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

async function login(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });
  return (await r.json().catch(() => null))?.access_token ?? null;
}
async function q(tok, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${tok}` },
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function rpc(tok, fn, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

for (const factory of ['alpha', 'beta']) {
  const fm = await login(`floor@${factory}.test`);
  if (!fm) { console.log(`\n### ${factory}: no floor login`); continue; }

  console.log(`\n################ ${factory.toUpperCase()} ################`);

  const PAST_GATE = [
    'awaiting_job_card', 'job_card_shared', 'job_card_confirmed',
    'machine_selection_pending', 'in_production', 'in_finishing',
    'awaiting_final_qa', 'ready_for_delivery', 'completed',
  ];
  const orders = await q(
    fm,
    `orders?select=id,order_code,status,created_at&status=in.(${PAST_GATE.join(',')})&order=created_at.asc`
  );

  const empty = [];
  for (const o of orders.body ?? []) {
    const sheets = await q(fm, `sheets?select=id,sheet_number,repeats_count&order_id=eq.${o.id}`);
    const sIds = (sheets.body ?? []).map((s) => s.id);
    const declared = (sheets.body ?? []).reduce((n, s) => n + (s.repeats_count ?? 0), 0);
    let coded = 0;
    if (sIds.length) {
      const reps = await q(fm, `repeats?select=id,current_status&sheet_id=in.(${sIds.join(',')})`);
      coded = reps.body?.length ?? 0;
    }
    const stages = await q(fm, `order_stages?select=id&order_id=eq.${o.id}`);
    const line = `  ${o.order_code}  ${o.status.padEnd(26)} sheets=${sIds.length} declared=${declared} coded=${coded} stages=${stages.body?.length ?? 0}`;
    if (coded === 0) { empty.push(o); console.log(`!!${line}`); }
    else console.log(line);
  }

  console.log(`\n  --> ${empty.length} order(s) past the job-card gate with ZERO coded repeats`);

  // How did they get there? Read the history of the first offender.
  if (empty.length) {
    const o = empty[0];
    console.log(`\n  Tracing ${o.order_code} (${o.id}):`);
    const sheets = await q(fm, `sheets?select=id,sheet_number,repeats_count&order_id=eq.${o.id}`);
    for (const s of sheets.body ?? []) {
      const d = await q(fm, `damage_records?select=id,stage_type,recheck_state,ot_return_confirmed_at&sheet_id=eq.${s.id}`);
      console.log(`    sheet ${s.sheet_number}: declared ${s.repeats_count}, damage rows ${d.body?.length ?? 0}` +
        (d.body?.length ? ` [${d.body.map((x) => `${x.stage_type}:${x.recheck_state ?? 'null'}`).join(', ')}]` : ''));
      const cnt = await rpc(fm, 'sheet_piece_counts', { p_sheet_id: s.id });
      console.log(`      sheet_piece_counts -> ${JSON.stringify(cnt.body)}`);
    }
    const jc = await q(fm, `job_cards?select=id,status,shared_at,confirmed_at&order_id=eq.${o.id}`);
    console.log(`    job card: ${JSON.stringify(jc.body)}`);
  }

  // Does fm_start_production currently refuse an order with zero repeats?
  const pending = await q(fm, `orders?select=id,order_code,status&status=eq.machine_selection_pending&limit=5`);
  for (const o of pending.body ?? []) {
    const sheets = await q(fm, `sheets?select=id&order_id=eq.${o.id}`);
    const sIds = (sheets.body ?? []).map((s) => s.id);
    let coded = 0;
    if (sIds.length) {
      const reps = await q(fm, `repeats?select=id&sheet_id=in.(${sIds.join(',')})`);
      coded = reps.body?.length ?? 0;
    }
    console.log(`\n  at machine_selection_pending: ${o.order_code} coded=${coded}`);
  }
}
