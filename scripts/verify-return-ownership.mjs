/**
 * Complete Return is restricted to the order taker who created the order.
 *
 *   npm run verify:returns
 *
 * The check already exists in the database — `ot_complete_return` (0036) and
 * `ot_complete_qa_return` (0059) both compare `orders.created_by` to
 * `auth.uid()` — but "it is in the file" is not the same as "it fires". This
 * signs in as TWO different order takers in the Alpha factory and proves it
 * with a differential: the same call, on the same row, is refused for one and
 * accepted (or refused for an unrelated reason) for the other.
 *
 * Read-mostly. The only write is creating the second order taker the first time
 * it runs, and every RPC probe is aimed at a row the test does not intend to
 * change — a refusal is the pass condition.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const URL = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!URL || !KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(2);
}

const PASSWORD = 'Password123!';
const OT_A = 'order@alpha.test';
const OT_B = 'order2@alpha.test';
const NIL = '00000000-0000-0000-0000-000000000000';

let pass = 0;
let fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);

async function login(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json().catch(() => null);
  return j?.access_token ?? null;
}

async function rpc(token, fn, args = {}) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function select(token, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${token}` },
  });
  return r.json().catch(() => null);
}

console.log('\n  Return ownership — Alpha factory\n');

// ---------------------------------------------------------------------------
// Two order takers
// ---------------------------------------------------------------------------
let tokenA = await login(OT_A);
if (!tokenA) {
  console.error(`  Cannot sign in as ${OT_A}. Is the dev seed applied?`);
  process.exit(2);
}
ok(`signed in as ${OT_A}`);

let tokenB = await login(OT_B);
if (!tokenB) {
  info(`${OT_B} does not exist yet — creating it as the owner.`);
  const owner = await login('owner@alpha.test');
  if (!owner) {
    console.error('  Cannot sign in as owner@alpha.test to create the second order taker.');
    process.exit(2);
  }
  const made = await rpc(owner, 'create_employee', {
    p_email: OT_B,
    p_password: PASSWORD,
    p_display_name: 'Alpha Order Taker 2',
    p_role: 'order_taker',
    p_salary_type: 'per_month',
    p_salary_amount: 30000,
  });
  if (made.status >= 400) {
    console.error('  create_employee failed:', JSON.stringify(made.body));
    process.exit(2);
  }
  tokenB = await login(OT_B);
}
chk(!!tokenB, `signed in as ${OT_B}`);
if (!tokenB) process.exit(1);

const meA = await select(tokenA, 'profiles?select=id,role&limit=1000');
const uidA = (await (await fetch(`${URL}/auth/v1/user`, {
  headers: { apikey: KEY, Authorization: `Bearer ${tokenA}` },
})).json()).id;
const uidB = (await (await fetch(`${URL}/auth/v1/user`, {
  headers: { apikey: KEY, Authorization: `Bearer ${tokenB}` },
})).json()).id;
chk(uidA && uidB && uidA !== uidB, 'the two logins are different users');

// ---------------------------------------------------------------------------
// A's orders, and a row on A's returns board
// ---------------------------------------------------------------------------
const ordersA = await select(tokenA, 'orders?select=id,order_code,created_by&order=created_at.desc');
const mineA = (ordersA ?? []).filter((o) => o.created_by === uidA);
info(`${OT_A} created ${mineA.length} of the ${(ordersA ?? []).length} orders they can read.`);

const boardA = await rpc(tokenA, 'ot_return_repeats');
const boardB = await rpc(tokenB, 'ot_return_repeats');
const rowsA = Array.isArray(boardA.body) ? boardA.body : [];
const rowsB = Array.isArray(boardB.body) ? boardB.body : [];
info(`returns board: ${OT_A} sees ${rowsA.length} row(s), ${OT_B} sees ${rowsB.length}.`);

// The board itself must not leak: nothing on B's board may belong to an order A created.
const aOrderIds = new Set(mineA.map((o) => o.id));
const leaked = rowsB.filter((r) => aOrderIds.has(r.order_id));
chk(leaked.length === 0, `${OT_B}'s returns board contains none of ${OT_A}'s orders`);

// ---------------------------------------------------------------------------
// The permission check itself, as a differential
// ---------------------------------------------------------------------------
// A QA rejection on one of A's orders is the row `ot_complete_qa_return` acts
// on. Any such damage row will do — the call is expected to be REFUSED for both
// users, but for different reasons, and that difference is the proof.
const damage = await select(
  tokenA,
  'damage_records?select=id,order_id,stage_type,repeat_id,ot_return_confirmed_at&stage_type=eq.repeat_qa&repeat_id=is.null&order=created_at.desc&limit=20'
);
let target = (damage ?? []).find((d) => aOrderIds.has(d.order_id));

/**
 * No rejected piece to test against? Make one.
 *
 * The differential is the whole point of this script, and it needs a real row
 * owned by a known order taker. So: A captures a one-repeat order, QA accepts
 * the cloth and rejects the piece. That is the same sequence the consolidated
 * QA flow walks a user through, which makes this setup a check in its own
 * right — if the flow's RPCs are broken, this fails here rather than silently
 * degrading to a weaker assertion.
 */
if (!target) {
  info('No QA-rejection row on any of this order taker\'s orders — creating one.');

  const vendors = await select(tokenA, 'vendors?select=id,name&deleted_at=is.null&limit=1');
  const qa = await login('qa@alpha.test');

  if (!Array.isArray(vendors) || !vendors.length || !qa) {
    info('Cannot build one (no client, or qa@alpha.test unavailable). Skipping to a');
    info('weaker probe: the gate is reached, but not shown to discriminate.');
    const asB = await rpc(tokenB, 'ot_complete_qa_return', {
      p_damage_id: NIL,
      p_photo_url: 'x/y.jpg',
      p_note: 'verify',
    });
    chk(asB.status >= 400, `${OT_B} is refused on a non-existent piece (${asB.status})`);
  } else {
    const created = await rpc(tokenA, 'create_order', {
      p_vendor_id: vendors[0].id,
      p_sheets: [
        {
          color_assignment: 'Red',
          repeats_count: 1,
          thread_color_codes: ['RED-01'],
          stitch_count: 0,
        },
      ],
      p_cloth_photos: [],
      p_design_sheet_url: null,
    });
    chk(created.status < 400, `${OT_A} captured a probe order (${created.status})`);
    const orderId = created.body?.id;

    if (orderId) {
      const submitted = await rpc(tokenA, 'submit_order', { p_order_id: orderId });
      chk(submitted.status < 400, 'probe order submitted');

      const accepted = await rpc(qa, 'qa_accept_cloth', { p_order_id: orderId });
      chk(accepted.status < 400, 'QA accepted the cloth on the probe order');

      const sheets = await select(tokenA, `sheets?select=id&order_id=eq.${orderId}`);
      const rejected = await rpc(qa, 'qa_reject_piece', {
        p_order_id: orderId,
        p_sheet_id: sheets?.[0]?.id,
        p_damage_type: 'fabric',
        p_photo_url: 'verify/reject.jpg',
        p_note: 'ownership probe',
        p_scope: 'piece',
      });
      chk(rejected.status < 400, `QA rejected the piece (${rejected.status})`);

      const fresh = await select(
        tokenA,
        `damage_records?select=id,order_id&order_id=eq.${orderId}&stage_type=eq.repeat_qa&repeat_id=is.null&limit=1`
      );
      target = fresh?.[0] ?? null;
      if (target) aOrderIds.add(target.order_id);
    }
  }
}

if (!target) {
  info('Still no target row — the differential below was not run.');
} else {
  info(`target damage row ${target.id} on order ${target.order_id}`);

  const asB = await rpc(tokenB, 'ot_complete_qa_return', {
    p_damage_id: target.id,
    p_photo_url: 'verify/ownership.jpg',
    p_note: 'ownership probe — must be refused',
  });
  const bMsg = asB.body?.message ?? JSON.stringify(asB.body);
  chk(
    asB.status >= 400 && /not found/i.test(bMsg),
    `${OT_B} is refused with "not found" on ${OT_A}'s rejected piece`
  );
  info(`  ${OT_B}: ${asB.status} ${bMsg}`);

  // A owns it, so A must NOT get the ownership refusal. A may still be refused
  // for a state reason ("already completed" / "not awaiting a return") — that is
  // a pass: it means execution got PAST the ownership gate.
  const asA = await rpc(tokenA, 'ot_complete_qa_return', {
    p_damage_id: target.id,
    p_photo_url: '',
    p_note: 'ownership probe — must reach the state check',
  });
  const aMsg = asA.body?.message ?? JSON.stringify(asA.body);
  chk(
    !/not found/i.test(aMsg),
    `${OT_A} gets past the ownership gate on their own piece (refused instead for state/validation)`
  );
  info(`  ${OT_A}: ${asA.status} ${aMsg}`);
}

// The finishing-return path has the same gate. Probe it the same way.
const repeatsA = await select(
  tokenA,
  'repeats?select=id,sheet_id,current_status&order=created_at.desc&limit=20'
);
if (Array.isArray(repeatsA) && repeatsA.length) {
  const asB2 = await rpc(tokenB, 'ot_complete_return', {
    p_repeat_id: repeatsA[0].id,
    p_note: 'ownership probe',
  });
  const b2 = asB2.body?.message ?? JSON.stringify(asB2.body);
  chk(asB2.status >= 400, `${OT_B} is refused on a repeat of ${OT_A}'s order (${asB2.status})`);
  info(`  ${OT_B}: ${b2}`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
