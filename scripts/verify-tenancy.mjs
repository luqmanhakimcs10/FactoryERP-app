/**
 * Tenancy & RLS acceptance suite.
 *
 * Runs against the live Supabase project using ONLY the anon key plus real user
 * logins — exactly the surface the app has. This is the regression net for the
 * one bug class that can end the business: cross-tenant data leakage.
 *
 * Every future phase must extend section 2/3 with its new tables and stay green.
 *
 *   node scripts/verify-tenancy.mjs
 *
 * Reads credentials from .env (EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY).
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
if (!URL || !KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(2);
}

const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

async function login(email, password = 'Password123!') {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  return r.ok ? j : null;
}

async function q(path, token) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function write(method, path, token, body) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** A write that RLS refuses: either 401/403, or 200/201 affecting zero rows. */
function refused(res) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 400) return true;
  return Array.isArray(res.body) && res.body.length === 0;
}

const ROLES = ['owner','accountant','floor','store','order','qa','procurement','delivery','worker','partner'];
const EXPECTED_ROLE = {
  owner: 'company_admin', accountant: 'accountant', floor: 'floor_manager',
  store: 'store_manager', order: 'order_taker', qa: 'qa',
  procurement: 'procurement', delivery: 'delivery', worker: 'worker',
  partner: 'finishing_partner',
};

(async () => {
  console.log('\n=== 1. All 21 seeded logins work, with correct role + factory ===');
  const tokens = {};
  const userIds = {};   // email -> auth user id, for "did this user create it?" checks
  for (const tenant of ['alpha', 'beta']) {
    for (const r of ROLES) {
      const email = `${r}@${tenant}.test`;
      const s = await login(email);
      if (!s?.access_token) { no(`${email} login`); continue; }
      tokens[email] = s.access_token;
      userIds[email] = s.user?.id ?? null;
      const prof = await q(`profiles?id=eq.${s.user.id}&select=role,factory_id,display_name`, s.access_token);
      const p = prof.body?.[0];
      const wantFactory = tenant === 'alpha' ? ALPHA : BETA;
      chk(p && p.role === EXPECTED_ROLE[r] && p.factory_id === wantFactory,
        `${email} -> role=${p?.role} factory=${tenant}`);
    }
  }
  const sa = await login('super@erp.test');
  if (sa?.access_token) {
    tokens['super@erp.test'] = sa.access_token;
    const p = (await q(`profiles?id=eq.${sa.user.id}&select=role,factory_id`, sa.access_token)).body?.[0];
    chk(p?.role === 'super_admin' && p?.factory_id === null, 'super@erp.test -> super_admin, no factory');
  } else no('super@erp.test login');

  console.log('\n=== 2. TENANT ISOLATION (the critical one) ===');
  const aTok = tokens['owner@alpha.test'], bTok = tokens['owner@beta.test'];

  const aSeesBeta = await q(`factories?id=eq.${BETA}&select=id,name`, aTok);
  chk(Array.isArray(aSeesBeta.body) && aSeesBeta.body.length === 0,
    `Alpha user reading Beta's factory row -> ${JSON.stringify(aSeesBeta.body)}`);

  const bSeesAlpha = await q(`factories?id=eq.${ALPHA}&select=id,name`, bTok);
  chk(Array.isArray(bSeesAlpha.body) && bSeesAlpha.body.length === 0,
    `Beta user reading Alpha's factory row -> ${JSON.stringify(bSeesAlpha.body)}`);

  const aAllFac = await q('factories?select=id', aTok);
  chk(aAllFac.body?.length === 1 && aAllFac.body[0].id === ALPHA,
    `Alpha user listing ALL factories sees only own (${aAllFac.body?.length} row)`);

  const aAllProf = await q('profiles?select=factory_id', aTok);
  chk(aAllProf.body?.length > 0 && aAllProf.body.every((r) => r.factory_id === ALPHA),
    `Alpha user listing ALL profiles sees only Alpha's (${aAllProf.body?.length} rows, all Alpha)`);

  const aBetaProf = await q(`profiles?factory_id=eq.${BETA}&select=id`, aTok);
  chk(aBetaProf.body?.length === 0, `Alpha user querying Beta's profiles -> ${JSON.stringify(aBetaProf.body)}`);

  const aBetaMods = await q(`factory_modules?factory_id=eq.${BETA}&select=id`, aTok);
  chk(aBetaMods.body?.length === 0, `Alpha user querying Beta's factory_modules -> ${JSON.stringify(aBetaMods.body)}`);

  console.log('\n=== 3. Cross-tenant WRITES are rejected ===');
  const wr = await fetch(`${URL}/rest/v1/factories?id=eq.${BETA}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${aTok}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ name: 'HACKED BY ALPHA' }),
  });
  const wrBody = await wr.json().catch(() => null);
  chk(wr.status === 403 || (Array.isArray(wrBody) && wrBody.length === 0),
    `Alpha user renaming Beta's factory -> HTTP ${wr.status} ${JSON.stringify(wrBody)?.slice(0,80)}`);

  const nameCheck = await q(`factories?id=eq.${BETA}&select=name`, tokens['owner@beta.test']);
  chk(nameCheck.body?.[0]?.name === 'Beta Stitch House',
    `Beta's name intact after attempted write -> "${nameCheck.body?.[0]?.name}"`);

  console.log('\n=== 4. Worker (lowest-privilege role) is also isolated ===');
  const wTok = tokens['worker@alpha.test'];
  const wBeta = await q(`factories?id=eq.${BETA}&select=id`, wTok);
  chk(wBeta.body?.length === 0, 'Alpha worker cannot read Beta factory');
  const wOwn = await q(`factories?select=name`, wTok);
  chk(wOwn.body?.[0]?.name === 'Alpha Embroidery Works', `Alpha worker CAN read own factory ("${wOwn.body?.[0]?.name}")`);

  console.log('\n=== 5. Super admin sees across tenants (tenancy mgmt only) ===');
  const sTok = tokens['super@erp.test'];
  const sFac = await q('factories?select=id,name&order=name', sTok);
  chk(sFac.body?.length === 2, `Super admin sees both factories (${sFac.body?.length})`);

  console.log('\n=== 6. Module gating data (Alpha=4 enabled, Beta=2) ===');
  const aMods = await q('factory_modules?enabled=is.true&select=modules(key)', aTok);
  chk(aMods.body?.length === 4, `Alpha enabled modules = ${aMods.body?.length} (${aMods.body?.map(r=>r.modules?.key).join(', ')})`);
  const bMods = await q('factory_modules?enabled=is.true&select=modules(key)', bTok);
  const bKeys = bMods.body?.map((r) => r.modules?.key).sort();
  chk(bMods.body?.length === 2 && bKeys?.includes('order_lifecycle') && bKeys?.includes('inventory_procurement'),
    `Beta enabled modules = ${bMods.body?.length} (${bKeys?.join(', ')})`);

  console.log('\n=== 7. module_enabled() RLS helper resolves per-caller ===');
  for (const [tok, label, key, want] of [
    [aTok, 'Alpha', 'machine_workforce', true],
    [bTok, 'Beta', 'machine_workforce', false],
    [bTok, 'Beta', 'order_lifecycle', true],
  ]) {
    const r = await fetch(`${URL}/rest/v1/rpc/module_enabled`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_module_key: key }),
    });
    const v = await r.json().catch(() => null);
    chk(v === want, `module_enabled('${key}') for ${label} -> ${v} (want ${want})`);
  }

  console.log('\n=== 8. Anonymous (no login) is fully blocked ===');
  for (const t of ['factories', 'profiles', 'factory_modules']) {
    const r = await q(`${t}?select=*`, KEY);
    chk(Array.isArray(r.body) && r.body.length === 0, `anon read ${t} -> ${JSON.stringify(r.body)}`);
  }

  console.log('\n=== 9. Bad password rejected ===');
  const bad = await login('owner@alpha.test', 'WrongPassword!');
  chk(bad === null, 'wrong password refused');

  // =========================================================================
  // PHASE 2 — master data (vendors, suppliers, machines, finishing partners)
  // =========================================================================
  const stamp = Date.now();
  const created = {}; // table -> id created under Alpha

  console.log('\n=== 10. Masters: create under Alpha (role-permitted writes) ===');
  const MASTER_CREATES = [
    ['vendors', { name: `V-Alpha-${stamp}`, contact: '0300-1', address: 'Karachi' }, aTok, 'owner'],
    ['suppliers', { name: `S-Alpha-${stamp}`, contact: '0300-2' }, aTok, 'owner'],
    ['machines', { name: `M-Alpha-${stamp}` }, aTok, 'owner'],
    ['finishing_partners', { name: `P-Alpha-${stamp}`, stage_type: 'clipping', rate_basis: 'per_repeat', rate: 12.5 }, aTok, 'owner'],
  ];
  for (const [table, payload, tok, who] of MASTER_CREATES) {
    const res = await write('POST', table, tok, payload);
    const row = Array.isArray(res.body) ? res.body[0] : res.body;
    if (row?.id) created[table] = row.id;
    chk(!!row?.id && row.factory_id === ALPHA, `${who} created ${table} -> ${row?.id ? 'ok' : JSON.stringify(res.body)?.slice(0,120)}`);
  }

  console.log('\n=== 11. MASTERS TENANT ISOLATION (the critical one) ===');
  for (const table of ['vendors', 'suppliers', 'machines', 'finishing_partners']) {
    const id = created[table];
    if (!id) { no(`${table}: no Alpha row to test with`); continue; }

    // Beta must not see Alpha's row, by id or by listing.
    const byId = await q(`${table}?id=eq.${id}&select=id`, bTok);
    chk(byId.body?.length === 0, `Beta cannot read Alpha's ${table} row by id -> ${JSON.stringify(byId.body)}`);

    const listed = await q(`${table}?select=factory_id`, bTok);
    const leaked = (listed.body ?? []).filter((r) => r.factory_id !== BETA);
    chk(leaked.length === 0, `Beta listing ${table} sees no Alpha rows (${listed.body?.length ?? 0} rows, ${leaked.length} leaked)`);

    // Beta must not be able to modify or remove Alpha's row.
    const upd = await write('PATCH', `${table}?id=eq.${id}`, bTok, { name: `HACKED-${stamp}` });
    chk(refused(upd), `Beta cannot UPDATE Alpha's ${table} row -> HTTP ${upd.status} ${JSON.stringify(upd.body)?.slice(0,60)}`);

    const del = await write('DELETE', `${table}?id=eq.${id}`, bTok);
    chk(refused(del), `Beta cannot DELETE Alpha's ${table} row -> HTTP ${del.status}`);

    // And confirm it's still intact from Alpha's side.
    const still = await q(`${table}?id=eq.${id}&select=name`, aTok);
    chk(still.body?.length === 1 && !String(still.body[0].name).startsWith('HACKED'),
      `Alpha's ${table} row intact after Beta's attempts ("${still.body?.[0]?.name}")`);
  }

  console.log('\n=== 12. Cross-tenant INSERT (forging factory_id) is rejected ===');
  for (const [table, payload] of [
    ['vendors', { name: `Forged-${stamp}`, factory_id: ALPHA }],
    ['suppliers', { name: `Forged-${stamp}`, factory_id: ALPHA }],
  ]) {
    const res = await write('POST', table, bTok, payload);
    chk(refused(res), `Beta inserting into ${table} with factory_id=Alpha -> HTTP ${res.status}`);
  }

  console.log('\n=== 13. Per-role write enforcement (RLS, not UI) ===');
  // worker/qa have no master write rights anywhere.
  const wTok2 = tokens['worker@alpha.test'];
  const qaTok = tokens['qa@alpha.test'];
  for (const [tok, who, table] of [
    [wTok2, 'worker', 'vendors'],
    [wTok2, 'worker', 'machines'],
    [qaTok, 'qa', 'suppliers'],
    [qaTok, 'qa', 'finishing_partners'],
  ]) {
    const res = await write('POST', table, tok, { name: `Nope-${who}-${table}-${stamp}`, stage_type: 'press', rate_basis: 'per_stitch', rate: 1 });
    chk(refused(res), `${who} CANNOT create ${table} -> HTTP ${res.status}`);
  }
  // order_taker owns vendors but not suppliers.
  const otTok = tokens['order@alpha.test'];
  const otVendor = await write('POST', 'vendors', otTok, { name: `V-OT-${stamp}` });
  chk(!refused(otVendor), `order_taker CAN create vendors -> HTTP ${otVendor.status}`);
  if (Array.isArray(otVendor.body) && otVendor.body[0]?.id) {
    await write('DELETE', `vendors?id=eq.${otVendor.body[0].id}`, aTok);
  }
  const otSupplier = await write('POST', 'suppliers', otTok, { name: `S-OT-${stamp}` });
  chk(refused(otSupplier), `order_taker CANNOT create suppliers -> HTTP ${otSupplier.status}`);

  // procurement owns suppliers but not machines.
  const procTok = tokens['procurement@alpha.test'];
  const procSup = await write('POST', 'suppliers', procTok, { name: `S-Proc-${stamp}` });
  chk(!refused(procSup), `procurement CAN create suppliers -> HTTP ${procSup.status}`);
  if (Array.isArray(procSup.body) && procSup.body[0]?.id) {
    await write('DELETE', `suppliers?id=eq.${procSup.body[0].id}`, aTok);
  }
  const procMach = await write('POST', 'machines', procTok, { name: `M-Proc-${stamp}` });
  chk(refused(procMach), `procurement CANNOT create machines -> HTTP ${procMach.status}`);

  // floor_manager owns machines.
  const fmTok = tokens['floor@alpha.test'];
  const fmMach = await write('POST', 'machines', fmTok, { name: `M-FM-${stamp}` });
  chk(!refused(fmMach), `floor_manager CAN create machines -> HTTP ${fmMach.status}`);
  if (Array.isArray(fmMach.body) && fmMach.body[0]?.id) {
    await write('DELETE', `machines?id=eq.${fmMach.body[0].id}`, aTok);
  }

  console.log('\n=== 14. MODULE GATING enforced in RLS (Beta has machine_workforce OFF) ===');
  const bFloorTok = tokens['floor@beta.test'];
  const bMachRead = await q('machines?select=id', bFloorTok);
  chk(Array.isArray(bMachRead.body) && bMachRead.body.length === 0,
    `Beta floor_manager reading machines (module off) -> ${JSON.stringify(bMachRead.body)}`);
  const bMachWrite = await write('POST', 'machines', bFloorTok, { name: `M-Beta-${stamp}` });
  chk(refused(bMachWrite), `Beta floor_manager CANNOT create machines (module off) -> HTTP ${bMachWrite.status}`);
  // Sanity: the same role in Alpha (module on) can.
  const aMachRead = await q('machines?select=id', fmTok);
  chk((aMachRead.body?.length ?? 0) > 0, `Alpha floor_manager CAN read machines (module on) -> ${aMachRead.body?.length} rows`);

  console.log('\n=== 15. Soft delete: archive hides the row, restore brings it back ===');
  {
    const id = created.vendors;
    await write('PATCH', `vendors?id=eq.${id}`, aTok, { deleted_at: new Date().toISOString() });
    const live = await q(`vendors?id=eq.${id}&deleted_at=is.null&select=id`, aTok);
    chk(live.body?.length === 0, 'archived vendor is excluded from the live list');
    const all = await q(`vendors?id=eq.${id}&select=id,deleted_at`, aTok);
    chk(all.body?.length === 1 && !!all.body[0].deleted_at, 'archived vendor still exists (data retained, not destroyed)');
    await write('PATCH', `vendors?id=eq.${id}`, aTok, { deleted_at: null });
    const back = await q(`vendors?id=eq.${id}&deleted_at=is.null&select=id`, aTok);
    chk(back.body?.length === 1, 'restore brings the vendor back into the live list');
  }

  console.log('\n=== 16. Duplicate names rejected per factory; same name OK across factories ===');
  {
    const dupName = `Dup-${stamp}`;
    const first = await write('POST', 'vendors', aTok, { name: dupName });
    chk(!refused(first), 'first vendor with the name created');
    const second = await write('POST', 'vendors', aTok, { name: dupName });
    chk(second.status === 409 || second.status >= 400, `duplicate name in same factory rejected -> HTTP ${second.status}`);
    // Beta may use the identical name — uniqueness is per-tenant.
    const betaSame = await write('POST', 'vendors', bTok, { name: dupName });
    chk(!refused(betaSame), `Beta CAN use the same vendor name (per-tenant uniqueness) -> HTTP ${betaSame.status}`);
    if (Array.isArray(first.body) && first.body[0]?.id) await write('DELETE', `vendors?id=eq.${first.body[0].id}`, aTok);
    if (Array.isArray(betaSame.body) && betaSame.body[0]?.id) await write('DELETE', `vendors?id=eq.${betaSame.body[0].id}`, bTok);
  }

  console.log('\n=== 17. Referenced record fails gracefully (no orphaning) ===');
  {
    // finishing_partners.user_id -> profiles is ON DELETE RESTRICT, so a profile
    // that a partner points at cannot be deleted out from under it.
    //
    // SAFETY: this attempts a DELETE on seeded data, so it only runs once the
    // link is CONFIRMED present — a correct FK then guarantees refusal. Without
    // that guard an unlinked row would actually be deleted.
    const partnerProfile = await q('profiles?role=eq.finishing_partner&select=id&limit=1', aTok);
    const pid = partnerProfile.body?.[0]?.id;

    if (!pid) {
      no('no finishing_partner profile in Alpha to link (re-run 0003b_seed_profiles_by_email.sql)');
    } else {
      const link = await write('PATCH', `finishing_partners?id=eq.${created.finishing_partners}`, aTok, { user_id: pid });
      chk(!refused(link), 'linked finishing partner to its dashboard login (linked-record field)');

      // Guard: only probe the delete if the link is genuinely readable back.
      const confirm = await q(`finishing_partners?id=eq.${created.finishing_partners}&select=user_id`, aTok);
      const linked = confirm.body?.[0]?.user_id === pid;
      chk(linked, 'link confirmed before probing the FK restriction');

      if (!linked) {
        console.log('  SKIP  FK delete probe — link not confirmed, refusing to risk seed data');
      } else {
        const delProfile = await write('DELETE', `profiles?id=eq.${pid}`, sTok);
        chk(refused(delProfile), `deleting a referenced profile is refused, not orphaned -> HTTP ${delProfile.status}`);

        const survived = await q(`profiles?id=eq.${pid}&select=id`, sTok);
        chk(survived.body?.length === 1, 'referenced profile still exists (nothing was orphaned)');
        if (survived.body?.length !== 1) {
          console.log('  !!  seed profile was deleted — re-run supabase/migrations/0003b_seed_profiles_by_email.sql');
        }
      }
    }
  }

  console.log('\n=== 18. Anonymous access to masters is blocked ===');
  for (const t of ['vendors', 'suppliers', 'machines', 'finishing_partners']) {
    const r = await q(`${t}?select=*`, KEY);
    chk(Array.isArray(r.body) && r.body.length === 0, `anon read ${t} -> ${JSON.stringify(r.body)}`);
    const w = await write('POST', t, KEY, { name: `anon-${stamp}` });
    chk(refused(w), `anon insert ${t} -> HTTP ${w.status}`);
  }

  // =========================================================================
  // PHASE 3 — the order spine (order -> sheets -> repeats)
  // =========================================================================
  // `dp` joins the set for the stage handover loop (0056): the delivery person
  // now owns both legs of every stage, so the walk cannot be driven without them.
  const A = { ot: tokens['order@alpha.test'], qa: tokens['qa@alpha.test'], fm: tokens['floor@alpha.test'], dp: tokens['delivery@alpha.test'] };
  const B = { ot: tokens['order@beta.test'], qa: tokens['qa@beta.test'], fm: tokens['floor@beta.test'], dp: tokens['delivery@beta.test'] };

  async function rpc(fn, tok, args) {
    const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  /** Drive a full order through the spine for one tenant. */
  async function runSpine(tk, label, colors, repeatsPerSheet) {
    const vend = await write('POST', 'vendors', tk.ot, { name: `Spine ${label} ${stamp}` });
    const vendorId = Array.isArray(vend.body) ? vend.body[0]?.id : null;

    const sheetsIn = [
      { color_assignment: 'Sheet A', repeats_count: repeatsPerSheet[0], thread_color_codes: colors, stitch_count: 10000 },
      { color_assignment: 'Sheet B', repeats_count: repeatsPerSheet[1], thread_color_codes: [colors[0]], stitch_count: 5000 },
    ];
    const created = await rpc('create_order', tk.ot, { p_vendor_id: vendorId, p_sheets: sheetsIn });
    const orderId = created.body?.id;
    const submitted = await rpc('submit_order', tk.ot, { p_order_id: orderId });
    return { vendorId, orderId, orderCode: created.body?.order_code, submit: submitted.body,
             expected: repeatsPerSheet[0] + repeatsPerSheet[1] };
  }

  console.log('\n=== 19. Order capture + inventory branch (both tenants) ===');
  // Alpha: stocked colours -> sufficient. Beta: stocked colours -> sufficient.
  const alphaRun = await runSpine(A, 'Alpha', ['RED-01', 'GLD-02'], [3, 2]);
  chk(!!alphaRun.orderId && alphaRun.orderCode?.startsWith('ALP-'),
    `Alpha order created with factory-prefixed code -> ${alphaRun.orderCode}`);
  chk(alphaRun.submit?.status === 'awaiting_cloth_inspection',
    `Alpha stocked colours -> ${alphaRun.submit?.status}`);

  const betaRun = await runSpine(B, 'Beta', ['RED-01'], [4, 1]);
  chk(!!betaRun.orderId && betaRun.orderCode?.startsWith('BET-'),
    `Beta order created with its own prefix -> ${betaRun.orderCode}`);
  chk(betaRun.submit?.status === 'awaiting_cloth_inspection',
    `Beta stocked colour -> ${betaRun.submit?.status}`);

  // Shortfall branch: an unstocked colour must raise an auto-PO.
  const shortCreate = await rpc('create_order', A.ot, { p_vendor_id: alphaRun.vendorId,
    p_sheets: [{ color_assignment: 'Neon', repeats_count: 2, thread_color_codes: ['ZZZ-99'], stitch_count: 9000 }] });
  const shortId = shortCreate.body?.id;
  const shortSubmit = await rpc('submit_order', A.ot, { p_order_id: shortId });
  chk(shortSubmit.body?.status === 'awaiting_procurement',
    `unstocked colour -> ${shortSubmit.body?.status}`);
  chk(!!shortSubmit.body?.po_code && shortSubmit.body?.shortfalls?.length === 1,
    `auto-PO raised on shortfall -> ${shortSubmit.body?.po_code}`);
  const poItems = await q(`po_items?purchase_order_id=eq.${shortSubmit.body?.purchase_order_id}&select=color_code,quantity_meters`, A.ot);
  chk(poItems.body?.[0]?.color_code === 'ZZZ-99', `PO line names the short colour -> ${JSON.stringify(poItems.body)}`);

  console.log('\n=== 20. QA inspection + repeat coding (one row per repeat) ===');
  const dmg = await rpc('qa_report_cloth_damage', A.qa,
    { p_order_id: alphaRun.orderId, p_damage_type: 'stains', p_note: 'water marks' });
  chk(dmg.body?.responsible_type === 'vendor' && dmg.body?.repeat_id === null,
    'incoming damage is vendor-accountable and pre-repeat (repeat_id null)');

  const acc = await rpc('qa_accept_cloth', A.qa, { p_order_id: alphaRun.orderId });
  chk(acc.body?.status === 'awaiting_coding', `accept cloth -> ${acc.body?.status}`);

  const coded = await rpc('qa_generate_repeats', A.qa, { p_order_id: alphaRun.orderId });
  chk(coded.body?.repeats_created === alphaRun.expected,
    `repeats created = ${coded.body?.repeats_created}, expected ${alphaRun.expected} (matches sheet entry)`);

  const alphaRepeats = await q(
    `repeats?select=repeat_code,current_status,sheets!inner(order_id)&sheets.order_id=eq.${alphaRun.orderId}`, A.qa);
  chk(alphaRepeats.body?.length === alphaRun.expected,
    `one repeats ROW per repeat, not a count -> ${alphaRepeats.body?.length} rows`);
  chk(alphaRepeats.body?.every(r => r.repeat_code?.startsWith(alphaRun.orderCode)),
    `every repeat_code is unique + human-readable -> e.g. ${alphaRepeats.body?.[0]?.repeat_code}`);
  chk(new Set(alphaRepeats.body?.map(r => r.repeat_code)).size === alphaRun.expected,
    'repeat codes are distinct');

  // Idempotency: re-running coding must not duplicate.
  const recode = await rpc('qa_generate_repeats', A.qa, { p_order_id: alphaRun.orderId });
  const afterRecode = await q(
    `repeats?select=id,sheets!inner(order_id)&sheets.order_id=eq.${alphaRun.orderId}`, A.qa);
  chk(afterRecode.body?.length === alphaRun.expected,
    `re-running coding does not duplicate (${recode.body?.repeats_created} new, still ${afterRecode.body?.length})`);

  console.log('\n=== 21. repeat_stage_history is written on EVERY transition ===');
  const histCoded = await q(
    `repeat_stage_history?select=id,status,actor_user_id,repeat_id&status=eq.coded`, A.qa);
  const codedForOrder = (histCoded.body ?? []).filter(h =>
    alphaRepeats.body?.some(r => r.repeat_code && h.repeat_id));
  chk((histCoded.body?.length ?? 0) >= alphaRun.expected,
    `'coded' history rows written at coding -> ${histCoded.body?.length}`);
  chk((histCoded.body ?? []).every(h => h.actor_user_id),
    'every history row records who did it (actor_user_id set)');

  console.log('\n=== 22. Floor manager: stages, job card, vendor loop ===');
  const seq = await rpc('fm_set_stage_sequence', A.fm, { p_order_id: alphaRun.orderId, p_stages: [
    { stage_type: 'embroidery', is_outsourced: false, sla_hours: 24 },
    { stage_type: 'clipping', is_outsourced: true, sla_hours: 48 },
    { stage_type: 'press', is_outsourced: false, sla_hours: 12 },
  ]});
  chk(seq.body?.stages === 3, `stage sequence written -> ${seq.body?.stages} stages`);

  const jc = await rpc('fm_generate_job_card', A.fm, { p_order_id: alphaRun.orderId });
  chk(jc.body?.lines === 2, `job card lines = one per distinct thread colour -> ${jc.body?.lines}`);
  const jcLines = await q(`job_card_lines?job_card_id=eq.${jc.body?.job_card_id}&select=id,needle_number,thread_color_code&order=needle_number`, A.fm);
  chk(jcLines.body?.every((l, i) => l.needle_number === i + 1),
    `needle numbers sequential -> ${JSON.stringify(jcLines.body?.map(l => l.needle_number + ':' + l.thread_color_code))}`);

  console.log('\n=== 22b. Job card: editable needle/colour mapping before confirmation (0037) ===');
  {
    const line = jcLines.body?.[0];
    if (line) {
      // Role: only floor_manager/company_admin may edit a line.
      const roleGate = await rpc('fm_update_job_card_line', A.qa,
        { p_job_card_id: jc.body.job_card_id, p_line_id: line.id, p_needle_number: 3, p_thread_color_code: 'X' });
      chk(roleGate.status >= 400, `QA is refused on fm_update_job_card_line -> HTTP ${roleGate.status}`);

      // Cross-tenant: Beta's floor manager cannot touch Alpha's line.
      const crossEdit = await rpc('fm_update_job_card_line', B.fm,
        { p_job_card_id: jc.body.job_card_id, p_line_id: line.id, p_needle_number: 3, p_thread_color_code: 'X' });
      chk(crossEdit.status >= 400, `Beta FM editing Alpha's job card line is refused -> HTTP ${crossEdit.status}`);

      // Needle cap: 1-6 only.
      const overCap = await rpc('fm_update_job_card_line', A.fm,
        { p_job_card_id: jc.body.job_card_id, p_line_id: line.id, p_needle_number: 7, p_thread_color_code: line.thread_color_code });
      chk(overCap.status >= 400, `needle number above 6 is refused -> HTTP ${overCap.status}`);

      // Positive: reassign the colour on this needle.
      const edited = await rpc('fm_update_job_card_line', A.fm,
        { p_job_card_id: jc.body.job_card_id, p_line_id: line.id, p_needle_number: line.needle_number, p_thread_color_code: 'EDITED-01' });
      chk(edited.status === 200 && edited.body?.thread_color_code === 'EDITED-01',
        `line edited before confirmation -> HTTP ${edited.status}, colour=${edited.body?.thread_color_code}`);
    } else no('no job card line to exercise fm_update_job_card_line against');
  }

  console.log('\n=== 22b2. "+ Add needle" is role- and tenant-scoped too (0053) ===');
  {
    const cardId = jc.body?.job_card_id;
    if (cardId) {
      chk((await rpc('fm_add_job_card_line', A.qa,
        { p_job_card_id: cardId, p_thread_color_code: 'X' })).status >= 400,
        'QA is refused on fm_add_job_card_line');
      chk((await rpc('fm_add_job_card_line', B.fm,
        { p_job_card_id: cardId, p_thread_color_code: 'X' })).status >= 400,
        "Beta FM adding a line to Alpha's job card is refused");
      chk(refused(await rpc('fm_add_job_card_line', KEY,
        { p_job_card_id: cardId, p_thread_color_code: 'X' })),
        'anonymous is refused on fm_add_job_card_line');

      // Positive, plus the invariant the screen depends on: the number comes
      // from position, never from the caller.
      const before = (await q(`job_card_lines?job_card_id=eq.${cardId}&select=id&order=needle_number`, A.fm)).body ?? [];
      const addedLine = await rpc('fm_add_job_card_line', A.fm,
        { p_job_card_id: cardId, p_thread_color_code: 'TENANCY-ADD' });
      chk(addedLine.status === 200 && addedLine.body?.needle_number === before.length + 1,
        `add assigns Needle ${addedLine.body?.needle_number} (position ${before.length + 1})`);

      if (addedLine.body?.id) {
        await rpc('fm_delete_job_card_line', A.fm, { p_job_card_id: cardId, p_line_id: addedLine.body.id });
      }
    } else no('no job card to exercise fm_add_job_card_line against');
  }

  // Job card cannot be confirmed before it is shared.
  const earlyConfirm = await rpc('fm_confirm_job_card', A.fm, { p_order_id: alphaRun.orderId });
  chk(earlyConfirm.status >= 400, `cannot confirm an unshared job card -> HTTP ${earlyConfirm.status}`);

  await rpc('fm_share_job_card', A.fm, { p_order_id: alphaRun.orderId });
  const changed = await rpc('fm_request_job_card_changes', A.fm,
    { p_order_id: alphaRun.orderId, p_notes: 'Swap needle 2' });
  chk(changed.body?.job_card_status === 'draft', 'changes-requested returns the card to draft');
  const afterChange = await q(`orders?id=eq.${alphaRun.orderId}&select=status`, A.fm);
  chk(afterChange.body?.[0]?.status === 'awaiting_job_card',
    `order loops back to the FM queue -> ${afterChange.body?.[0]?.status}`);

  await rpc('fm_share_job_card', A.fm, { p_order_id: alphaRun.orderId });
  const confirmed = await rpc('fm_confirm_job_card', A.fm, { p_order_id: alphaRun.orderId });
  chk(confirmed.body?.job_card_status === 'confirmed', 'job card reaches Confirmed after the loop');
  chk(confirmed.body?.repeats_advanced === alphaRun.expected,
    `all ${confirmed.body?.repeats_advanced} repeats advanced on confirm`);

  const histReady = await q(`repeat_stage_history?select=id&status=eq.ready_for_production`, A.fm);
  chk((histReady.body?.length ?? 0) >= alphaRun.expected,
    `confirm wrote history rows too (not just a status flip) -> ${histReady.body?.length}`);

  // The cache must agree with the source of truth.
  const cacheCheck = await q(
    `repeats?select=current_status,sheets!inner(order_id)&sheets.order_id=eq.${alphaRun.orderId}`, A.fm);
  chk(cacheCheck.body?.every(r => r.current_status === 'ready_for_production'),
    'repeats.current_status cache matches the newest history status');

  console.log('\n=== 22c. Needle mapping locks on confirm; vendor-informed; ask-for-material gate (0037-0039) ===');
  {
    // Locked: a confirmed card's lines can no longer be edited.
    const lockedLine = jcLines.body?.[0];
    if (lockedLine) {
      const lockedEdit = await rpc('fm_update_job_card_line', A.fm,
        { p_job_card_id: jc.body.job_card_id, p_line_id: lockedLine.id, p_needle_number: lockedLine.needle_number, p_thread_color_code: 'AFTER-CONFIRM' });
      chk(lockedEdit.status >= 400, `needle mapping is locked once confirmed -> HTTP ${lockedEdit.status}`);
    }

    // Mark vendor informed: idempotent, independent of the share/confirm status flip.
    const informed1 = await rpc('fm_mark_vendor_informed', A.fm, { p_order_id: alphaRun.orderId });
    chk(informed1.status === 200 && !!informed1.body?.vendor_informed_at,
      `fm_mark_vendor_informed -> HTTP ${informed1.status}`);
    const informed2 = await rpc('fm_mark_vendor_informed', A.fm, { p_order_id: alphaRun.orderId });
    chk(informed2.status === 200 && informed2.body?.vendor_informed_at !== informed1.body?.vendor_informed_at,
      're-marking vendor informed succeeds and bumps the timestamp (idempotent)');
    chk((await rpc('fm_mark_vendor_informed', A.qa, { p_order_id: alphaRun.orderId })).status >= 400,
      'QA is refused on fm_mark_vendor_informed');

    // Ask for material: THE regression test for the visibility-gate change (0039) —
    // confirming a job card alone must no longer be enough to reach the store
    // manager's queue.
    const storeTok = tokens['store@alpha.test'];
    const beforeAsk = await rpc('material_issue_queue', storeTok, {});
    chk(!(beforeAsk.body ?? []).some((r) => r.job_card_id === jc.body.job_card_id),
      'confirmed job card is NOT in the material queue before "Ask for material"');

    chk((await rpc('fm_ask_for_material', B.fm, { p_order_id: alphaRun.orderId })).status >= 400,
      "Beta FM is refused on Alpha's fm_ask_for_material");
    chk((await rpc('fm_ask_for_material', A.qa, { p_order_id: alphaRun.orderId })).status >= 400,
      'QA is refused on fm_ask_for_material');

    const asked = await rpc('fm_ask_for_material', A.fm, { p_order_id: alphaRun.orderId });
    chk(asked.status === 200 && !!asked.body?.material_requested_at,
      `fm_ask_for_material -> HTTP ${asked.status}`);

    const afterAsk = await rpc('material_issue_queue', storeTok, {});
    chk((afterAsk.body ?? []).some((r) => r.job_card_id === jc.body.job_card_id),
      'confirmed + requested job card now appears in the material queue');

    chk((await rpc('fm_ask_for_material', A.fm, { p_order_id: alphaRun.orderId })).status >= 400,
      'asking twice for the same job card is refused');
  }

  console.log('\n=== 23. ORDER SPINE TENANT ISOLATION ===');
  for (const [table, filter] of [
    ['orders', `id=eq.${alphaRun.orderId}`],
    ['sheets', `order_id=eq.${alphaRun.orderId}`],
    ['order_stages', `order_id=eq.${alphaRun.orderId}`],
    ['job_cards', `order_id=eq.${alphaRun.orderId}`],
    ['damage_records', `order_id=eq.${alphaRun.orderId}`],
    ['purchase_orders', `order_id=eq.${shortId}`],
  ]) {
    const seen = await q(`${table}?${filter}&select=id`, B.ot);
    chk(seen.body?.length === 0, `Beta cannot read Alpha's ${table} -> ${JSON.stringify(seen.body)}`);
  }

  const betaSeesRepeats = await q('repeats?select=factory_id', B.qa);
  chk((betaSeesRepeats.body ?? []).every(r => r.factory_id === BETA),
    `Beta's repeats list contains only Beta rows (${betaSeesRepeats.body?.length} rows)`);
  const betaSeesHistory = await q('repeat_stage_history?select=factory_id', B.qa);
  chk((betaSeesHistory.body ?? []).every(h => h.factory_id === BETA),
    `Beta's history contains only Beta rows (${betaSeesHistory.body?.length} rows)`);

  // Queue badge counts must not include the other tenant.
  const alphaQueue = await q('orders?status=in.(awaiting_cloth_inspection,awaiting_coding)&select=factory_id', A.qa);
  chk((alphaQueue.body ?? []).every(o => o.factory_id === ALPHA),
    `Alpha's QA queue count excludes Beta (${alphaQueue.body?.length} orders)`);

  // Cross-tenant RPC calls must be refused, not silently act.
  const crossRpc = await rpc('qa_generate_repeats', B.qa, { p_order_id: alphaRun.orderId });
  chk(crossRpc.status >= 400, `Beta QA calling an RPC on Alpha's order -> HTTP ${crossRpc.status}`);
  const crossStage = await rpc('fm_set_stage_sequence', B.fm,
    { p_order_id: alphaRun.orderId, p_stages: [{ stage_type: 'press', is_outsourced: false, sla_hours: 24 }] });
  chk(crossStage.status >= 400, `Beta FM setting stages on Alpha's order -> HTTP ${crossStage.status}`);
  const stagesIntact = await q(`order_stages?order_id=eq.${alphaRun.orderId}&select=id`, A.fm);
  chk(stagesIntact.body?.length === 3, `Alpha's stages intact after Beta's attempt (${stagesIntact.body?.length})`);

  console.log('\n=== 24. Order taker is READ-ONLY after submit (enforced, not implied) ===');
  const otEdit = await write('PATCH', `orders?id=eq.${alphaRun.orderId}`, A.ot, { status: 'draft' });
  chk(refused(otEdit), `order taker cannot edit a submitted order -> HTTP ${otEdit.status} ${JSON.stringify(otEdit.body)?.slice(0,50)}`);

  const otSheet = await write('POST', 'sheets', A.ot,
    { order_id: alphaRun.orderId, sheet_number: 99, color_assignment: 'sneak', repeats_count: 1, stitch_count: 1 });
  chk(refused(otSheet), `order taker cannot add sheets to a submitted order -> HTTP ${otSheet.status}`);

  // Every QA / job-card action the order detail screen's tabs could offer. The
  // UI hides them and the navigator never registers those screens for this role,
  // but the database is what makes it true rather than merely tidy.
  for (const [fn, args] of [
    ['qa_accept_cloth', { p_order_id: shortId }],
    ['qa_generate_repeats', { p_order_id: alphaRun.orderId }],
    ['qa_report_cloth_damage', { p_order_id: alphaRun.orderId, p_damage_type: 'fabric', p_note: 'probe' }],
    ['fm_set_stage_sequence', { p_order_id: alphaRun.orderId, p_stages: [{ stage_type: 'press', is_outsourced: false, sla_hours: 24 }] }],
    ['fm_generate_job_card', { p_order_id: alphaRun.orderId }],
    ['fm_share_job_card', { p_order_id: alphaRun.orderId }],
    ['fm_confirm_job_card', { p_order_id: alphaRun.orderId }],
    ['fm_mark_vendor_informed', { p_order_id: alphaRun.orderId }],
    ['fm_ask_for_material', { p_order_id: alphaRun.orderId }],
  ]) {
    const r2 = await rpc(fn, A.ot, args);
    chk(r2.status >= 400, `order taker calling ${fn}() is refused -> HTTP ${r2.status}`);
  }

  // Nobody can forge history or the status cache directly.
  const forgeHist = await write('POST', 'repeat_stage_history', A.fm, {
    repeat_id: alphaRepeats.body?.[0] ? (await q(`repeats?repeat_code=eq.${alphaRepeats.body[0].repeat_code}&select=id`, A.fm)).body?.[0]?.id : null,
    status: 'completed',
  });
  chk(refused(forgeHist), `direct INSERT into repeat_stage_history is refused -> HTTP ${forgeHist.status}`);

  const forgeStatus = await write('PATCH',
    `repeats?repeat_code=eq.${alphaRepeats.body?.[0]?.repeat_code}`, A.fm, { current_status: 'completed' });
  chk(refused(forgeStatus), `direct UPDATE of repeats.current_status is refused -> HTTP ${forgeStatus.status}`);

  console.log('\n=== 25. Timeline is derived, not hardcoded ===');
  const tl = await rpc('order_timeline', A.ot, { p_order_id: alphaRun.orderId });
  const keys = (tl.body ?? []).map(s => s.step_key);
  chk(keys.filter(k => k.startsWith('stage_')).length === 3,
    `timeline shows exactly the 3 configured stages -> ${keys.join(', ')}`);
  const codingStep = (tl.body ?? []).find(s => s.step_key === 'coding');
  chk(codingStep?.state === 'done' && codingStep?.detail?.includes(String(alphaRun.expected)),
    `coding step derived from history -> "${codingStep?.detail}"`);

  const tlShort = await rpc('order_timeline', A.ot, { p_order_id: shortId });
  const shortKeys = (tlShort.body ?? []).map(s => s.step_key);
  chk(shortKeys.includes('procurement') && shortKeys.filter(k => k.startsWith('stage_')).length === 0,
    `shortfall order's timeline differs (has procurement, no stages) -> ${shortKeys.join(', ')}`);

  console.log('\n=== 26. Anonymous blocked on the whole spine ===');
  for (const t of ['orders','sheets','repeats','repeat_stage_history','job_cards','damage_records']) {
    const r3 = await q(`${t}?select=*`, KEY);
    chk(Array.isArray(r3.body) && r3.body.length === 0, `anon read ${t} -> ${JSON.stringify(r3.body)}`);
  }

  // =========================================================================
  // PHASE 4 — inventory & procurement
  // =========================================================================
  const AP = { proc: tokens['procurement@alpha.test'], sm: tokens['store@alpha.test'],
               acc: tokens['accountant@alpha.test'] };
  const BP = { proc: tokens['procurement@beta.test'], sm: tokens['store@beta.test'] };

  console.log('\n=== 27. Opening stock is one-time per factory ===');
  {
    const again = await rpc('sm_opening_stock', AP.sm,
      { p_items: [{ color_code: 'RED-01', quantity_meters: 999 }] });
    chk(again.status >= 400 && /already recorded/i.test(again.body?.message ?? ''),
      `re-running opening stock is refused -> HTTP ${again.status}`);

    const stockBefore = await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm);
    chk(Number(stockBefore.body?.[0]?.quantity_meters) !== 999,
      'the refused re-run changed nothing');
  }

  console.log('\n=== 28. PO walk: execute -> bill -> approve -> pay -> handover -> GRN ===');
  const supRes = await write('POST', 'suppliers', AP.proc, { name: `Sup-${stamp}` });
  const supplierId = Array.isArray(supRes.body) ? supRes.body[0]?.id : null;

  const poRes = await rpc('po_create_manual', AP.proc, {
    p_supplier_id: supplierId,
    p_items: [
      { color_code: 'RED-01', quantity_meters: 4000 },
      { color_code: `TST-${stamp % 100}`, quantity_meters: 2000 },
      { description: 'Backing paper', quantity_meters: 25 },
    ],
    p_notes: 'verification run',
  });
  const poId = poRes.body?.id;
  chk(!!poId && poRes.body?.status === 'draft', `manual PO raised -> ${poRes.body?.po_code}`);

  // Steps must happen in order.
  const earlyBill = await rpc('po_upload_bill', AP.proc, { p_po_id: poId, p_bill_url: 'x.jpg' });
  chk(earlyBill.status >= 400, `cannot upload a bill before executing -> HTTP ${earlyBill.status}`);

  chk((await rpc('po_execute', AP.proc, { p_po_id: poId })).body?.status === 'executed', 'execute');
  chk((await rpc('po_upload_bill', AP.proc,
      { p_po_id: poId, p_bill_url: 'alpha/bill.jpg', p_amount: 31000 })).body?.status
      === 'awaiting_approval', 'bill upload -> awaiting owner approval');

  // Wrong roles are refused at each gate.
  chk(refused(await rpc('po_owner_approve', AP.proc, { p_po_id: poId })),
    'procurement cannot approve its own PO');
  chk(refused(await rpc('po_record_payment', AP.proc, { p_po_id: poId })),
    'procurement cannot record payment');
  const earlyHandover = await rpc('po_handover_to_store', AP.proc, { p_po_id: poId });
  chk(earlyHandover.status >= 400, `cannot hand over before payment -> HTTP ${earlyHandover.status}`);

  chk((await rpc('po_owner_approve', aTok, { p_po_id: poId })).body?.status === 'approved',
    'owner approves (RPC; Phase 7 adds the Approvals Inbox UI)');
  chk((await rpc('po_record_payment', AP.acc, { p_po_id: poId })).body?.status === 'paid',
    'accountant records payment (RPC; Phase 7 adds the Ledgers UI)');

  const handover = await rpc('po_handover_to_store', AP.proc, { p_po_id: poId, p_note: '2 cartons' });
  const grnId = handover.body?.id;
  chk(!!grnId && handover.body?.status === 'pending',
    `handover created GRN -> ${handover.body?.grn_code}`);
  chk((await q(`purchase_orders?id=eq.${poId}&select=status`, AP.proc)).body?.[0]?.status === 'handed_over',
    'PO moved to handed_over');
  chk(refused(await rpc('po_handover_to_store', AP.proc, { p_po_id: poId })) ||
      (await rpc('po_handover_to_store', AP.proc, { p_po_id: poId })).status >= 400,
    'a second handover of the same PO is refused');

  console.log('\n=== 29. GRN confirm raises stock and logs a movement ===');
  const testColor = `TST-${stamp % 100}`;
  const redBefore = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);

  // Stock must not have moved on handover alone.
  chk(Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters) === redBefore,
    'handover alone does not change stock (nobody has counted it yet)');

  const grnItems = await q(`grn_items?grn_id=eq.${grnId}&select=id,color_code,expected_meters`, AP.sm);
  chk(grnItems.body?.length === 3, `GRN copied all PO lines -> ${grnItems.body?.length}`);
  const testLine = grnItems.body?.find((i) => i.color_code === testColor);

  // Short-deliver the new colour: 1500 of 2000.
  const grnConfirmed = await rpc('sm_confirm_grn', AP.sm, {
    p_grn_id: grnId,
    p_received: [{ grn_item_id: testLine.id, received_meters: 1500 }],
  });
  chk(grnConfirmed.body?.lines_received === 2,
    `only thread lines credit stock -> ${grnConfirmed.body?.lines_received} of 3 lines`);

  const redAfter = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);
  chk(redAfter === redBefore + 4000, `RED-01 rose by the received amount: ${redBefore} -> ${redAfter}`);

  const testStock = Number((await q(`thread_stock?color_code=eq.${testColor}&select=quantity_meters`, AP.sm)).body?.[0]?.quantity_meters ?? 0);
  chk(testStock === 1500, `short delivery credited only what arrived -> ${testStock} of 2000`);

  const grnMoves = await q(`stock_movements?ref_id=eq.${grnId}&select=movement_type,quantity_meters,color_code`, AP.sm);
  chk(grnMoves.body?.length === 2 && grnMoves.body.every((m) => m.movement_type === 'grn' && Number(m.quantity_meters) > 0),
    `grn movements logged, all positive -> ${JSON.stringify(grnMoves.body?.map(m => m.color_code + ':' + m.quantity_meters))}`);
  chk((await q(`purchase_orders?id=eq.${poId}&select=status`, AP.proc)).body?.[0]?.status === 'received',
    'PO closed out as received');

  console.log('\n=== 30. Material issue deducts stock and traces to the job card ===');
  const queue = await rpc('material_issue_queue', AP.sm, {});
  chk(Array.isArray(queue.body), `issue queue readable -> ${queue.body?.length} job card(s)`);
  // Must be THIS run's order, not queue.body[0]. The queue is ordered by
  // confirmed_at ascending, so the head is the oldest unissued card in the
  // factory — on a project with leftover test data that is somebody else's
  // order, and every later section keyed to alphaRun (accept inventory, assign
  // machine, start production, the whole stage loop) then fails on an order
  // that was never issued materials.
  const jcRow = (queue.body ?? []).find((r) => r.order_id === alphaRun.orderId);
  if (!jcRow) { no(`this run's order ${alphaRun.orderCode} is not in the material issue queue`); }
  else {
    const reqs = await rpc('job_card_requirements', AP.sm, { p_job_card_id: jcRow.job_card_id });
    const redReq = Number((reqs.body ?? []).find((r) => r.color_code === 'RED-01')?.required_meters ?? 0);
    const before = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);

    const issued = await rpc('sm_issue_materials', AP.sm, { p_job_card_id: jcRow.job_card_id });
    chk(issued.status === 200 && issued.body?.lines > 0,
      `issued ${issued.body?.lines} colour(s) -> ${issued.body?.issue_code}`);

    const after = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);
    chk(Math.abs((before - redReq) - after) < 0.01,
      `RED-01 fell by exactly the requirement: ${before} - ${redReq} = ${after}`);

    const issueId = issued.body?.material_issue_id;
    const issueMoves = await q(`stock_movements?ref_id=eq.${issueId}&select=movement_type,quantity_meters`, AP.sm);
    chk((issueMoves.body ?? []).every((m) => m.movement_type === 'issue' && Number(m.quantity_meters) < 0),
      `issue movements logged, all negative -> ${issueMoves.body?.length}`);

    // Traceable back to the specific job card.
    const trace = await q(`material_issues?id=eq.${issueId}&select=job_card_id,order_id,issue_code`, AP.sm);
    chk(trace.body?.[0]?.job_card_id === jcRow.job_card_id,
      'movement -> material_issue -> job card chain is intact');

    chk((await rpc('sm_issue_materials', AP.sm, { p_job_card_id: jcRow.job_card_id })).status >= 400,
      'issuing twice for the same job card is refused');

    // Over-issuing must abort rather than drive stock negative.
    const drain = await rpc('log_stock_movement', AP.sm,
      { p_color_code: 'RED-01', p_quantity: -99999999, p_movement_type: 'issue' });
    chk(drain.status >= 400, `stock cannot be driven negative -> HTTP ${drain.status}`);

    console.log('\n=== 30b. Floor manager: accept inventory requires a photo (0040) ===');
    const noPhoto = await rpc('fm_accept_inventory', A.fm, { p_material_issue_id: issueId, p_photo_url: null });
    chk(noPhoto.status >= 400, `accepting with no photo is refused -> HTTP ${noPhoto.status}`);
    const emptyPhoto = await rpc('fm_accept_inventory', A.fm, { p_material_issue_id: issueId, p_photo_url: '  ' });
    chk(emptyPhoto.status >= 400, `accepting with a blank photo is refused -> HTTP ${emptyPhoto.status}`);

    // Role/tenant: only this factory's floor manager can accept it.
    chk((await rpc('fm_accept_inventory', A.qa, { p_material_issue_id: issueId, p_photo_url: 'x.jpg' })).status >= 400,
      'QA is refused on fm_accept_inventory');
    chk((await rpc('fm_accept_inventory', B.fm, { p_material_issue_id: issueId, p_photo_url: 'x.jpg' })).status >= 400,
      "Beta FM is refused on Alpha's material issue");

    const accepted = await rpc('fm_accept_inventory', A.fm,
      { p_material_issue_id: issueId, p_photo_url: `${ALPHA}/${jcRow.order_id}/material-accepted-probe.jpg` });
    chk(accepted.status === 200 && !!accepted.body?.accepted_photo_url,
      `accept with a photo succeeds -> HTTP ${accepted.status}, accepted_photo_url set`);

    chk((await rpc('fm_accept_inventory', A.fm, { p_material_issue_id: issueId, p_photo_url: 'x.jpg' })).status >= 400,
      'accepting the same material issue twice is refused');
  }

  console.log('\n=== 31. Audit variance adjusts stock and is recorded ===');
  {
    const before = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);
    const counted = before - 750;   // deliberate mismatch
    const audit = await rpc('sm_submit_audit', AP.sm, {
      p_items: [{ color_code: 'RED-01', actual_meters: counted }],
      p_note: 'verification count',
    });
    chk(audit.body?.variances === 1, `audit recorded ${audit.body?.variances} variance -> ${audit.body?.audit_code}`);

    const after = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);
    chk(after === counted, `stock set to the counted figure: ${before} -> ${after}`);

    const item = await q(`stock_audit_items?stock_audit_id=eq.${audit.body?.stock_audit_id}&select=expected_meters,actual_meters,variance_meters`, AP.sm);
    chk(Number(item.body?.[0]?.variance_meters) === -750,
      `variance stored as signed delta -> ${item.body?.[0]?.variance_meters}`);

    const moves = await q(`stock_movements?ref_id=eq.${audit.body?.stock_audit_id}&select=movement_type,quantity_meters`, AP.sm);
    chk(moves.body?.[0]?.movement_type === 'audit_variance' && Number(moves.body?.[0]?.quantity_meters) === -750,
      'audit_variance movement logged with the signed delta');
  }

  console.log('\n=== 32. FULL LEDGER TRAIL for one colour reconstructs correctly ===');
  {
    const ledger = await rpc('stock_ledger', AP.sm, { p_color_code: 'RED-01' });
    const rows = ledger.body ?? [];
    chk(rows.length >= 4, `RED-01 has a full trail -> ${rows.length} movements`);

    const types = rows.map((r) => r.movement_type);
    chk(types.includes('opening') && types.includes('grn') && types.includes('issue') && types.includes('audit_variance'),
      `trail covers every movement type -> ${[...new Set(types)].join(' -> ')}`);

    chk(rows.every((r) => r.actor && r.created_at && r.movement_type),
      'every movement records type, quantity, actor and timestamp');
    chk(rows.filter((r) => r.movement_type !== 'opening').every((r) => !!r.ref_code),
      'every non-opening movement references the event that caused it');

    // The whole point of a signed ledger: it must reconstruct the balance.
    const sum = rows.reduce((n, r) => n + Number(r.quantity_meters), 0);
    const bal = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);
    chk(Math.abs(sum - bal) < 0.01, `running sum ${sum} === balance ${bal}`);

    // And balance_after must agree step by step.
    let walk = 0, stepOk = true;
    for (const r of rows) { walk += Number(r.quantity_meters); if (Math.abs(walk - Number(r.balance_after)) > 0.01) stepOk = false; }
    chk(stepOk, 'balance_after agrees with the running sum at every step');
  }

  console.log('\n=== 32b. Automatic low-stock PO generation (0046) — no manual trigger ===');
  {
    chk((await rpc('sm_set_reorder_levels', A.qa, { p_color_code: 'RED-01', p_reorder_threshold: 1, p_reorder_quantity: 1 })).status >= 400,
      'QA is refused on sm_set_reorder_levels');

    const before = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);
    const existingOpenAutoPos = async () => {
      const pos = await q(`purchase_orders?auto_created=eq.true&status=not.in.(received,cancelled)&select=id,po_items(color_code)`, AP.proc);
      return (pos.body ?? []).filter((p) => (p.po_items ?? []).some((i) => i.color_code === 'RED-01')).length;
    };
    const openBefore = await existingOpenAutoPos();

    // Threshold just above the current balance: the very next movement, of
    // any size, crosses it.
    const levels = await rpc('sm_set_reorder_levels', AP.sm, {
      p_color_code: 'RED-01', p_reorder_threshold: before + 1, p_reorder_quantity: 500,
    });
    // 0074 made sm_set_reorder_levels a `returns table (...)`, so the response
    // is a one-row array rather than an object. The change was needed to stop the
    // function depending on the thread_stock view's composite type, which made
    // 0068's `drop view` unre-runnable.
    const levelRow = Array.isArray(levels.body) ? levels.body[0] : levels.body;
    chk(levels.status === 200 && Number(levelRow?.reorder_threshold) === before + 1,
      `reorder threshold set -> HTTP ${levels.status}`);

    // Path 1: sm_submit_audit crosses the threshold. Every real mutation path in
    // this app (GRN/issue/audit) always passes a proper ref_type/ref_id through
    // log_stock_movement — a bare direct call would leave an unreferenced ledger
    // row no real UI ever produces, so both dedup paths here go through actual
    // store-manager RPCs instead.
    await rpc('sm_submit_audit', AP.sm, { p_items: [{ color_code: 'RED-01', actual_meters: before - 1 }] });
    const afterFirst = await existingOpenAutoPos();
    // >= 1, not === openBefore + 1: purchase orders are business records this
    // suite deliberately never deletes (same policy as orders — see the Phase 3
    // cleanup note below), so a prior run of this script against the same
    // project may have already left an open auto PO for this colour. Either a
    // fresh one was raised or the dedup correctly found the old one still open
    // — both prove the same thing. What must never happen is zero.
    chk(afterFirst >= Math.max(openBefore, 1), `at least one auto PO is open for RED-01 after crossing the threshold -> ${afterFirst}`);

    // Path 2: a second, distinct sm_submit_audit call while still below
    // threshold must NOT raise a second PO for the same colour.
    const stillBelow = Number((await q('thread_stock?color_code=eq.RED-01&select=quantity_meters', AP.sm)).body?.[0]?.quantity_meters ?? 0);
    await rpc('sm_submit_audit', AP.sm, { p_items: [{ color_code: 'RED-01', actual_meters: stillBelow - 5 }] });
    const afterSecond = await existingOpenAutoPos();
    chk(afterSecond === afterFirst, 'a second movement while still below threshold does not raise a duplicate PO');

    // The auto PO carries a sane reorder quantity and is visible on the
    // Procurement dashboard exactly like any other auto-generated PO.
    const newPos = await q(
      `purchase_orders?auto_created=eq.true&order_id=is.null&select=id,po_code,status,po_items(color_code,quantity_meters)&order=created_at.desc&limit=5`,
      AP.proc);
    const ourPo = (newPos.body ?? []).find((p) => (p.po_items ?? []).some((i) => i.color_code === 'RED-01' && Number(i.quantity_meters) === 500));
    chk(!!ourPo, `low-stock auto PO exists with the configured reorder quantity -> ${ourPo?.po_code}`);

    // Clean up: clear the threshold so later runs of this script don't keep re-triggering it.
    await rpc('sm_set_reorder_levels', AP.sm, { p_color_code: 'RED-01', p_reorder_threshold: null, p_reorder_quantity: null });
  }

  console.log('\n=== 33. INVENTORY TENANT ISOLATION ===');
  for (const [table, filter] of [
    ['purchase_orders', `id=eq.${poId}`],
    ['grns', `id=eq.${grnId}`],
  ]) {
    const seen = await q(`${table}?${filter}&select=id`, BP.proc);
    chk(seen.body?.length === 0, `Beta cannot read Alpha's ${table} -> ${JSON.stringify(seen.body)}`);
  }
  for (const [table, tok, label] of [
    ['thread_stock', BP.sm, 'stock'],
    ['stock_movements', BP.sm, 'movements'],
    ['grns', BP.sm, 'GRNs'],
    ['material_issues', BP.sm, 'issues'],
    ['stock_audits', BP.sm, 'audits'],
  ]) {
    const rows2 = await q(`${table}?select=factory_id`, tok);
    chk((rows2.body ?? []).every((r) => r.factory_id === BETA),
      `Beta's ${label} contain only Beta rows (${rows2.body?.length})`);
  }

  const crossGrn = await rpc('sm_confirm_grn', BP.sm, { p_grn_id: grnId });
  chk(crossGrn.status >= 400, `Beta store manager confirming Alpha's GRN -> HTTP ${crossGrn.status}`);
  const crossPo = await rpc('po_execute', BP.proc, { p_po_id: poId });
  chk(crossPo.status >= 400, `Beta procurement executing Alpha's PO -> HTTP ${crossPo.status}`);

  // Beta's own ledger must be untouched by all of Alpha's activity above.
  const betaLedger = await rpc('stock_ledger', BP.sm, { p_color_code: 'RED-01' });
  chk((betaLedger.body ?? []).every((r) => !r.ref_code || !String(r.ref_code).includes('ALP')),
    `Beta's RED-01 ledger references no Alpha documents (${betaLedger.body?.length} rows)`);

  console.log('\n=== 34. Direct writes to stock and the ledger are refused ===');
  chk(refused(await write('PATCH', 'thread_stock?color_code=eq.RED-01', AP.sm, { quantity_meters: 1 })),
    'direct UPDATE of thread_stock is refused');
  chk(refused(await write('POST', 'stock_movements', AP.sm,
      { color_code: 'RED-01', movement_type: 'grn', quantity_meters: 5, balance_after: 5,
        thread_stock_id: '00000000-0000-0000-0000-000000000000' })),
    'direct INSERT into stock_movements is refused');
  for (const t of ['thread_stock', 'stock_movements', 'grns', 'purchase_orders']) {
    const r4 = await q(`${t}?select=*`, KEY);
    chk(Array.isArray(r4.body) && r4.body.length === 0, `anon read ${t} -> ${JSON.stringify(r4.body)}`);
  }

  // =========================================================================
  // PHASE 5 — shift close + payroll
  // =========================================================================

  // Pre-flight: check that Phase 5 functions exist in the schema cache.
  const phase5Check = await rpc('fm_list_machines', A.fm);
  const phase5Ready = phase5Check.status !== 404 && phase5Check.body?.code !== 'PGRST202';
  if (!phase5Ready) {
    console.log('\n  ⚠  Phase 5 functions not found in schema cache.');
    console.log('     Run _combined_phase5.sql in the Supabase SQL editor first.\n');
  }

  const MACHINE_M01 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001';
  const MACHINE_M02 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002';
  const workerProf = await q(`profiles?display_name=eq.Alpha Worker&select=id`, A.fm);
  const workerId = workerProf.body?.[0]?.id;
  let shiftId = null;
  let idleShiftId = null;

  /** Safe array coerce — PostgREST error objects pass nullish-coalescing but fail .some/.find */
  const asArr = (v) => Array.isArray(v) ? v : [];

  console.log('\n=== 35. Floor manager lists managed machines ===');
  {
    // Clean up any lingering open shifts on test machines from previous runs
    const existingOpen = await q(`shifts?status=eq.open&select=id`, A.fm);
    if (Array.isArray(existingOpen.body)) {
      for (const s of existingOpen.body) {
        await rpc('fm_flag_shift_idle', A.fm, { p_shift_id: s.id });
      }
    }

    // Ensure M-01 and M-02 exist for Alpha factory and are assigned to Alpha Floor Mgr
    const fmProf = await q(`profiles?role=eq.floor_manager&select=id`, A.fm);
    const fmId = fmProf.body?.[0]?.id;
    if (fmId) {
      await write('PATCH', `machines?id=eq.${MACHINE_M01}`, aTok, { managed_by: fmId, deleted_at: null });
      await write('PATCH', `machines?id=eq.${MACHINE_M02}`, aTok, { managed_by: fmId, deleted_at: null });
    }

    const machines = await rpc('fm_list_machines', A.fm);
    chk(machines.status === 200 && Array.isArray(machines.body) && machines.body.length >= 2,
      `Alpha FM sees managed machines -> ${Array.isArray(machines.body) ? machines.body.length : 0}`);
  }

  console.log('\n=== 35b. Assign machine is refused when no machine has an open shift (0041) ===');
  {
    // Section 35 just flagged any lingering open shifts idle, so at this point
    // no Alpha machine should have one — this is the exact "no active shift"
    // case the Assign-a-machine modal's guidance copy describes.
    const noShift = await rpc('fm_assign_machine', A.fm, { p_order_id: alphaRun.orderId, p_machine_id: MACHINE_M01 });
    chk(noShift.status >= 400, `assigning a machine with no open shift is refused -> HTTP ${noShift.status}`);

    // Wrong order status: the shortfall order never reached machine_selection_pending.
    const wrongStatus = await rpc('fm_assign_machine', A.fm, { p_order_id: shortId, p_machine_id: MACHINE_M01 });
    chk(wrongStatus.status >= 400, `assigning a machine to an order not awaiting selection is refused -> HTTP ${wrongStatus.status}`);
  }

  console.log('\n=== 36. Open shift + close posts worker_ledger ===');
  if (workerId) {
    // Worker photo is now required (0042) — refused without one.
    const noWorkerPhoto = await rpc('fm_open_shift', A.fm, {
      p_machine_id: MACHINE_M01,
      p_worker_id: workerId,
      p_order_id: alphaRun.orderId,
      p_open_photo_url: 'alpha/shifts/test/open.jpg',
      p_open_stitches: 1000,
      p_worker_photo_url: null,
    });
    chk(noWorkerPhoto.status >= 400, `opening a shift with no worker photo is refused -> HTTP ${noWorkerPhoto.status}`);

    const reportedStart = new Date();
    reportedStart.setHours(6, 30, 0, 0);
    const opened = await rpc('fm_open_shift', A.fm, {
      p_machine_id: MACHINE_M01,
      p_worker_id: workerId,
      p_order_id: alphaRun.orderId,
      p_open_photo_url: 'alpha/shifts/test/open.jpg',
      p_open_stitches: 1000,
      p_worker_photo_url: 'alpha/shifts/test/worker.jpg',
      p_reported_start_time: reportedStart.toISOString(),
    });
    shiftId = typeof opened.body === 'string' ? opened.body : null;
    chk(opened.status === 200 && !!shiftId, `shift opened on M-01 -> ${shiftId ? String(shiftId).slice(0, 8) : JSON.stringify(opened.body)}`);

    if (shiftId) {
      const shiftRow = await q(`shifts?id=eq.${shiftId}&select=worker_photo_url,reported_start_time,opened_at`, A.fm);
      chk(!!shiftRow.body?.[0]?.worker_photo_url, 'worker_photo_url stored on the shift');
      const reportedMs = new Date(shiftRow.body?.[0]?.reported_start_time ?? 0).getTime();
      chk(Math.abs(reportedMs - reportedStart.getTime()) < 1000,
        `reported_start_time carries the picked time -> ${shiftRow.body?.[0]?.reported_start_time}`);
      chk(shiftRow.body?.[0]?.opened_at !== shiftRow.body?.[0]?.reported_start_time,
        'opened_at is the real insert time, independent of reported_start_time (payroll/report math untouched)');
    }

    if (shiftId) {
      console.log('\n=== 36b. Assign machine + Shift Calendar, while M-01 has an open shift (0041) ===');
      {
        chk((await rpc('fm_assign_machine', A.qa, { p_order_id: alphaRun.orderId, p_machine_id: MACHINE_M01 })).status >= 400,
          'QA is refused on fm_assign_machine');
        chk((await rpc('fm_assign_machine', B.fm, { p_order_id: alphaRun.orderId, p_machine_id: MACHINE_M01 })).status >= 400,
          "Beta FM is refused on Alpha's fm_assign_machine");

        const assigned = await rpc('fm_assign_machine', A.fm, { p_order_id: alphaRun.orderId, p_machine_id: MACHINE_M01 });
        chk(assigned.status === 200 && assigned.body?.assigned_machine_id === MACHINE_M01,
          `machine assigned -> HTTP ${assigned.status}`);
        chk(assigned.body?.status === 'machine_selection_pending',
          'assigning a machine does not by itself change order status');

        const todayKey = new Date().toISOString().slice(0, 10);
        const calendar = await rpc('fm_shifts_for_date', A.fm, { p_date: todayKey });
        const m01Today = (calendar.body ?? []).find((r) => r.machine_id === MACHINE_M01);
        chk(m01Today?.status === 'open', `Shift Calendar shows M-01 open today -> ${m01Today?.status}`);
        chk((await rpc('fm_shifts_for_date', A.ot, { p_date: todayKey })).status >= 400,
          'order taker is refused on fm_shifts_for_date');
      }

      console.log('\n=== 36c. Start production hands repeats into the stage-tracking loop (0043/0044) ===');
      {
        chk((await rpc('fm_start_production', A.qa, { p_order_id: alphaRun.orderId })).status >= 400,
          'QA is refused on fm_start_production');
        chk((await rpc('fm_start_production', B.fm, { p_order_id: alphaRun.orderId })).status >= 400,
          "Beta FM is refused on Alpha's fm_start_production");

        // Wrong precondition: the shortfall order never reached machine_selection_pending.
        chk((await rpc('fm_start_production', A.fm, { p_order_id: shortId })).status >= 400,
          'starting production on an order not awaiting it is refused');

        const started = await rpc('fm_start_production', A.fm, { p_order_id: alphaRun.orderId });
        chk(started.status === 200 && started.body?.status === 'in_production',
          `fm_start_production -> HTTP ${started.status}, order status ${started.body?.status}`);
        chk(started.body?.repeats_advanced === alphaRun.expected,
          `all ${started.body?.repeats_advanced} repeats advanced`);

        const afterStart = await q(
          `repeats?select=current_status,current_stage_index,sheets!inner(order_id)&sheets.order_id=eq.${alphaRun.orderId}`, A.fm);
        // 0056: stage 1 opens directly at in_progress — there is no "Start stage".
        chk((afterStart.body ?? []).every((r) => r.current_status === 'in_progress' && r.current_stage_index === 1),
          'every repeat opens at in_progress on stage index 1 (no Start stage step)');

        // Second call: order is no longer machine_selection_pending.
        chk((await rpc('fm_start_production', A.fm, { p_order_id: alphaRun.orderId })).status >= 400,
          'starting production twice is refused');
      }

      console.log('\n=== 36d. Repeats & Stage Tracking loop, QA-only Pass QA / Mark damage (0045) ===');
      {
        const loopRepeats = await q(
          `repeats?select=id,repeat_code,sheets!inner(order_id)&sheets.order_id=eq.${alphaRun.orderId}&order=repeat_code`, A.fm);
        const walk = loopRepeats.body?.[0];
        const other = loopRepeats.body?.[1];

        if (walk) {
          // Role gates, exercised once each on the walked repeat before it moves.
          chk((await rpc('qa_pass_stage_qa', A.fm, { p_repeat_id: walk.id })).status >= 400,
            'FM is refused on qa_pass_stage_qa (wrong state AND wrong role, but must still be refused)');
          chk((await rpc('fm_send_to_stage_qa', A.qa, { p_repeat_id: walk.id })).status >= 400,
            'QA is refused on fm_send_to_stage_qa');
          chk((await rpc('fm_start_stage', A.fm, { p_repeat_id: walk.id })).status === 404,
            'fm_start_stage is dropped, not merely unused (0056)');

          // The stage partner the delivery leg needs.
          const fpRow = await q('finishing_partners?select=id,name&deleted_at=is.null&limit=1', A.fm);
          const partnerId = fpRow.body?.[0]?.id;

          // Full walk through all 3 configured stages, each one now making the
          // complete round trip out through the delivery person and back.
          for (let stage = 1; stage <= 3; stage++) {
            const sentQa = await rpc('fm_send_to_stage_qa', A.fm, { p_repeat_id: walk.id });
            chk(sentQa.status === 200 && sentQa.body?.current_status === 'stage_qa',
              `stage ${stage}: In Progress -> Go to QA -> ${sentQa.body?.current_status}`);

            const passed = await rpc('qa_pass_stage_qa', A.qa, { p_repeat_id: walk.id });
            chk(passed.status === 200 && passed.body?.current_status === 'handover_for_delivery',
              `stage ${stage}: Stage QA pass -> ${passed.body?.current_status}`);

            const handed = await rpc('fm_hand_over_stage', A.fm, { p_repeat_id: walk.id });
            chk(handed.status === 200 && handed.body?.current_status === 'awaiting_dp_collection',
              `stage ${stage}: Hand over -> ${handed.body?.current_status}`);

            chk((await rpc('dp_collect_from_floor', A.dp, { p_repeat_id: walk.id, p_photo_url: '' })).status >= 400,
              `stage ${stage}: Collect without a photo is refused`);
            const got = await rpc('dp_collect_from_floor', A.dp,
              { p_repeat_id: walk.id, p_photo_url: `alpha/vt-collect-${stage}.jpg` });
            chk(got.status === 200 && got.body?.current_status === 'handed_over',
              `stage ${stage}: Collect (photo) -> ${got.body?.current_status}`);

            const out = await rpc('dp_send_to_partner', A.dp, { p_repeat_id: walk.id, p_partner_id: partnerId });
            chk(out.status === 200 && out.body?.current_status === 'handed_off',
              `stage ${stage}: Handover to finishing partner -> ${out.body?.current_status}`);

            const back = await rpc('dp_collect_from_partner', A.dp,
              { p_repeat_id: walk.id, p_photo_url: `alpha/vt-back-${stage}.jpg` });
            chk(back.status === 200 && back.body?.current_status === 'returned_to_delivery',
              `stage ${stage}: Collect back from partner (photo) -> ${back.body?.current_status}`);

            const handBack = await rpc('dp_hand_back_to_floor', A.dp, { p_repeat_id: walk.id });
            chk(handBack.status === 200 && handBack.body?.current_status === 'awaiting_fm_collection',
              `stage ${stage}: Hand back to Floor Manager -> ${handBack.body?.current_status}`);

            chk((await rpc('fm_confirm_collection', A.dp, { p_repeat_id: walk.id })).status >= 400,
              `stage ${stage}: delivery is refused on the FM's collection confirmation`);
            const collected = await rpc('fm_confirm_collection', A.fm, { p_repeat_id: walk.id });
            const expectedNext = stage < 3 ? 'in_progress' : 'awaiting_final_qa';
            chk(collected.status === 200 && collected.body?.current_status === expectedNext,
              `stage ${stage}: FM Collect -> ${collected.body?.current_status} (expected ${expectedNext})`);
            if (stage < 3) {
              chk(collected.body?.current_stage_index === stage + 1,
                `stage ${stage}: next stage ${collected.body?.current_stage_index} opened automatically`);
            }
          }

          // The two final gates.
          const fmFinal = await rpc('fm_final_qa_pass', A.fm, { p_repeat_id: walk.id });
          chk(fmFinal.status === 200 && fmFinal.body?.status === 'awaiting_qa_final',
            `FM Final QA -> ${fmFinal.body?.status} (not completed outright)`);
          chk((await rpc('qa_final_pass', A.fm, { p_repeat_id: walk.id, p_photo_url: 'alpha/fq.jpg' })).status >= 400,
            "FM is refused on QA final pass (the two gates are different roles)");
          // 0062: a photo of the finished product is required.
          chk((await rpc('qa_final_pass', A.qa, { p_repeat_id: walk.id, p_photo_url: '' })).status >= 400,
            'QA final pass without a product photo is refused');
          const qaFinal = await rpc('qa_final_pass', A.qa, { p_repeat_id: walk.id, p_photo_url: 'alpha/final-product.jpg' });
          chk(qaFinal.status === 200 && qaFinal.body?.status === 'completed',
            `QA final pass -> ${qaFinal.body?.status}`);
        } else no('no coded repeat to walk through the stage-tracking loop');

        if (other) {
          // Mark damage: QA-only, and resolves responsible_id from the shift's worker.
          chk((await rpc('mark_stage_damage', A.fm, { p_repeat_id: other.id, p_damage_type: 'fabric' })).status >= 400,
            'FM is refused on mark_stage_damage');

          const damaged = await rpc('mark_stage_damage', A.qa,
            { p_repeat_id: other.id, p_damage_type: 'fabric', p_note: 'stage tracking test' });
          chk(damaged.status === 200 && !!damaged.body?.damage_id,
            `mark_stage_damage -> HTTP ${damaged.status}`);
          chk(damaged.body?.responsible_id === workerId,
            `damage attributed to the worker on the repeat's assigned machine's open shift -> ${damaged.body?.responsible_id}`);

          const damagedRow = await q(`repeats?id=eq.${other.id}&select=current_status`, A.fm);
          chk(damagedRow.body?.[0]?.current_status === 'damaged', 'repeat flipped to damaged');
        } else no('no second repeat to exercise mark_stage_damage against');
      }

      const queue = await rpc('fm_shift_close_queue', A.fm);
      chk(Array.isArray(queue.body) && queue.body.some((r) => r.shift_id === shiftId),
        `open shift appears on the close walk list -> ${Array.isArray(queue.body) ? queue.body.length + ' rows' : JSON.stringify(queue.body)}`);

      const closed = await rpc('fm_close_shift', A.fm, {
        p_shift_id: shiftId,
        p_close_photo_url: 'alpha/shifts/test/close.jpg',
        p_detected_stitches: 5500,
        p_confirmed_stitches: 5500,
      });
      chk(closed.status === 200 && closed.body?.stitch_count === 4500,
        `close posted ${closed.body?.stitch_count} stitches -> net ${closed.body?.net}`);

      const ledger = await q(`worker_ledger?shift_id=eq.${shiftId}&select=stitch_count,net,status`, A.fm);
      chk(ledger.body?.[0]?.stitch_count === 4500 && ledger.body?.[0]?.status === 'pending',
        `worker_ledger row pending with 4500 stitches -> net ${ledger.body?.[0]?.net}`);

      const doubleClose = await rpc('fm_close_shift', A.fm, {
        p_shift_id: shiftId,
        p_close_photo_url: 'alpha/shifts/test/close2.jpg',
        p_detected_stitches: 6000,
        p_confirmed_stitches: 6000,
      });
      chk(doubleClose.status >= 400, `closing twice is refused -> HTTP ${doubleClose.status}`);
    }
  } else no('Alpha Worker profile not found for shift tests');

  console.log('\n=== 37. Flag idle skips ledger posting ===');
  if (workerId && phase5Ready) {
    const openedIdle = await rpc('fm_open_shift', A.fm, {
      p_machine_id: MACHINE_M02,
      p_worker_id: workerId,
      p_order_id: null,
      p_open_photo_url: 'alpha/shifts/test/open-idle.jpg',
      p_open_stitches: 0,
      p_worker_photo_url: 'alpha/shifts/test/worker-idle.jpg',
    });
    idleShiftId = typeof openedIdle.body === 'string' ? openedIdle.body : null;
    chk(!!idleShiftId, `second shift opened on M-02 -> ${idleShiftId ? String(idleShiftId).slice(0, 8) : JSON.stringify(openedIdle.body)}`);

    if (idleShiftId) {
      const flagged = await rpc('fm_flag_shift_idle', A.fm, {
        p_shift_id: idleShiftId,
        p_close_photo_url: 'alpha/shifts/test/idle.jpg',
        p_detected_stitches: 0,
      });
      chk(flagged.status === 200 || flagged.status === 204, `idle shift flagged -> HTTP ${flagged.status}`);

      const idleLedger = await q(`worker_ledger?shift_id=eq.${idleShiftId}&select=id`, A.fm);
      chk(asArr(idleLedger.body).length === 0, 'flagged_idle shift has no ledger row');

      const shiftRow = await q(`shifts?id=eq.${idleShiftId}&select=status`, A.fm);
      chk(shiftRow.body?.[0]?.status === 'flagged_idle', 'shift status is flagged_idle');
    } else no('idle shift open failed; skipping flag tests');
  } else if (!phase5Ready) no('Phase 5 not deployed; skipping section 37');

  console.log('\n=== 38. Accountant salary run summary ===');
  if (phase5Ready && shiftId) {
    const summary = await rpc('acct_salary_run_summary', AP.acc);
    const summaryArr = asArr(summary.body);
    chk(summary.status === 200 && summaryArr.length >= 1,
      `salary run lists workers -> ${summaryArr.length} ${summary.status !== 200 ? '(HTTP ' + summary.status + ')' : ''}`);

    const pending = summaryArr.find((r) => r.worker_name === 'Alpha Worker');
    chk(pending?.has_pending === true && Number(pending?.total_stitches) >= 4500,
      `Alpha Worker pending with ${pending?.total_stitches} stitches`);

    const finalized = await rpc('acct_finalize_salary_run', AP.acc, { p_period: null, p_worker_ids: null });
    chk(finalized.status === 200 && finalized.body?.finalized_count >= 1,
      `finalized ${finalized.body?.finalized_count} entries for ${finalized.body?.period}`);

    const after = await q(`worker_ledger?shift_id=eq.${shiftId}&select=status`, AP.acc);
    chk(after.body?.[0]?.status === 'finalized', 'closed shift ledger entry is finalized');
  } else if (!phase5Ready) no('Phase 5 not deployed; skipping section 38');
  else no('No shift closed in section 36; skipping section 38');

  console.log('\n=== 39. Beta module gating blocks shift RPCs ===');
  {
    const betaMachines = await rpc('fm_list_machines', B.fm);
    chk(betaMachines.status >= 400,
      `Beta FM cannot list machines (module off) -> HTTP ${betaMachines.status}`);

    const betaOpen = await rpc('fm_open_shift', B.fm, {
      p_machine_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001',
      p_worker_id: workerId,
      p_order_id: null,
      p_open_photo_url: 'beta/shifts/test/open.jpg',
      p_open_stitches: 0,
      p_worker_photo_url: 'beta/shifts/test/worker.jpg',
    });
    chk(betaOpen.status >= 400, `Beta FM cannot open shift -> HTTP ${betaOpen.status}`);
  }

  console.log('\n=== 40. SHIFT + PAYROLL TENANT ISOLATION ===');
  if (shiftId) {
    const betaShift = await q(`shifts?id=eq.${shiftId}&select=id`, B.fm);
    chk(betaShift.body?.length === 0, `Beta cannot read Alpha's shift -> ${JSON.stringify(betaShift.body)}`);

    const betaLedger = await q(`worker_ledger?shift_id=eq.${shiftId}&select=id`, B.fm);
    chk(betaLedger.body?.length === 0, `Beta cannot read Alpha's worker_ledger -> ${JSON.stringify(betaLedger.body)}`);

    const crossClose = await rpc('fm_close_shift', B.fm, {
      p_shift_id: shiftId,
      p_close_photo_url: 'hack.jpg',
      p_detected_stitches: 1,
      p_confirmed_stitches: 1,
    });
    chk(crossClose.status >= 400, `Beta FM closing Alpha shift -> HTTP ${crossClose.status}`);
  }

  for (const [table, tok, label] of [
    ['shifts', B.fm, 'shifts'],
    ['worker_ledger', AP.acc, 'worker_ledger'],
    ['bonus_slabs', AP.acc, 'bonus_slabs'],
  ]) {
    const rows5 = await q(`${table}?select=factory_id`, tok);
    chk(asArr(rows5.body).every((r) => r.factory_id === (tok === AP.acc ? ALPHA : BETA)),
      `${label} rows scoped to caller factory (${asArr(rows5.body).length})`);
  }

  console.log('\n=== 41. Direct writes to shifts and worker_ledger are refused ===');
  chk(refused(await write('POST', 'shifts', A.fm, {
    factory_id: ALPHA,
    machine_id: MACHINE_M01,
    worker_id: workerId,
    open_panel_photo_url: 'x.jpg',
    open_stitches: 0,
    status: 'open',
  })), 'direct INSERT into shifts is refused');
  chk(refused(await write('POST', 'worker_ledger', AP.acc, {
    factory_id: ALPHA,
    worker_id: workerId,
    period: '2026-07',
    stitch_count: 100,
    base_per_stitch: 0.05,
    bonus: 0,
    damage_deduction: 0,
    loan_installment: 0,
    net: 5,
    status: 'pending',
  })), 'direct INSERT into worker_ledger is refused');
  for (const t of ['shifts', 'worker_ledger', 'bonus_slabs', 'downtime_reports']) {
    const r5 = await q(`${t}?select=*`, KEY);
    chk(Array.isArray(r5.body) && r5.body.length === 0, `anon read ${t} -> ${JSON.stringify(r5.body)}`);
  }

  // =========================================================================
  // PHASE 8 completion — Super Admin + Company Admin (0028, 0029, 0030)
  // =========================================================================
  const caStamp = Date.now();
  let caVendId = null, caSupId = null, caMachId = null, caPartnerId = null;

  console.log('\n=== 42. Super admin: business reads revoked, tenancy + billing kept (0028) ===');
  {
    // Business data is now invisible to super_admin through REST.
    for (const t of ['orders', 'vendors', 'machines', 'invoices', 'payments', 'expenses', 'loans', 'worker_ledger', 'finishing_partners']) {
      const r = await q(`${t}?select=id`, sTok);
      chk(Array.isArray(r.body) && r.body.length === 0, `super_admin CANNOT read ${t} -> ${JSON.stringify(r.body)}`);
    }

    // The two explicitly granted inventory tables are readable (read-only).
    const saStock = await q('thread_stock?select=color_code', sTok);
    chk(Array.isArray(saStock.body) && saStock.body.length > 0,
      `super_admin CAN read thread_stock (read-only) -> ${saStock.body?.length} rows`);
    const saMoves = await q('stock_movements?select=id', sTok);
    chk(Array.isArray(saMoves.body) && saMoves.body.length > 0,
      `super_admin CAN read stock_movements (read-only) -> ${saMoves.body?.length} rows`);
    chk(refused(await write('PATCH', 'thread_stock?color_code=eq.RED-01', sTok, { quantity_meters: 1 })),
      'super_admin cannot WRITE thread_stock (read-only grant)');

    // Tenancy + billing stay visible through the sa_* RPCs.
    const saList = await rpc('sa_factory_list', sTok, {});
    const saIds = (saList.body ?? []).map((f) => f.id);
    chk(saIds.length >= 2 && saIds.includes(ALPHA) && saIds.includes(BETA),
      `sa_factory_list sees all factories incl. Alpha + Beta -> ${saIds.length}`);
    const alphaRow = (saList.body ?? []).find((f) => f.id === ALPHA);
    chk(alphaRow?.account_status === 'active' && alphaRow?.active_modules === 4,
      `Alpha billing row: active, ${alphaRow?.active_modules} modules, amount ${alphaRow?.subscription_amount}`);
    chk((saList.body ?? []).some((f) => f.id === BETA && f.subscription_status === 'unpaid'),
      'Beta billing row: subscription unpaid');

    // sa_* RPCs refuse non-super-admin callers.
    chk(refused(await rpc('sa_toggle_module', aTok, { p_factory_id: ALPHA, p_module_key: 'machine_workforce', p_enabled: true })),
      'company_admin calling sa_toggle_module is refused');
    chk(refused(await rpc('sa_create_factory', aTok, { p_name: 'Sneak' })),
      'company_admin calling sa_create_factory is refused');
    chk(refused(await rpc('sa_set_account_status', aTok, { p_factory_id: ALPHA, p_active: false })),
      'company_admin calling sa_set_account_status is refused');
    chk((await rpc('my_factory_active', aTok, {})).body === true, 'my_factory_active true for Alpha user');
    chk((await rpc('my_factory_active', sTok, {})).body === true, 'my_factory_active true for super_admin');
  }

  console.log('\n=== 43. Masters columns land + constraints hold (0030) ===');
  {
    const cliBefore = Number((await rpc('master_client_stats', aTok, {})).body?.[0]?.total_clients ?? 0);
    const vend = await write('POST', 'vendors', aTok, { name: `CA-V-${caStamp}`, rate_per_repeat: 25, rate_per_stitch: 0.5, price: 1200 });
    caVendId = Array.isArray(vend.body) ? vend.body[0]?.id : null;
    chk(!!caVendId, `vendor with rates created -> ${caVendId ? 'ok' : JSON.stringify(vend.body)?.slice(0, 100)}`);
    const vendBack = await q(`vendors?id=eq.${caVendId}&select=rate_per_repeat,rate_per_stitch,price`, aTok);
    chk(Number(vendBack.body?.[0]?.rate_per_repeat) === 25 && Number(vendBack.body?.[0]?.price) === 1200,
      `vendor rates stored -> ${JSON.stringify(vendBack.body?.[0])}`);
    chk(Number((await rpc('master_client_stats', aTok, {})).body?.[0]?.total_clients) === cliBefore + 1,
      `client stats are LIVE: ${cliBefore} -> ${cliBefore + 1} after adding a client`);

    const sup = await write('POST', 'suppliers', aTok, { name: `CA-S-${caStamp}`, address: 'SITE Karachi', payment_day: 5 });
    caSupId = Array.isArray(sup.body) ? sup.body[0]?.id : null;
    const supBack = await q(`suppliers?id=eq.${caSupId}&select=address,payment_day`, aTok);
    chk(supBack.body?.[0]?.address === 'SITE Karachi' && Number(supBack.body?.[0]?.payment_day) === 5,
      `supplier address + payment_day stored -> ${JSON.stringify(supBack.body?.[0])}`);

    const mach = await write('POST', 'machines', aTok, { name: `CA-M-${caStamp}`, machine_type: 'overlock' });
    caMachId = Array.isArray(mach.body) ? mach.body[0]?.id : null;
    const machBack = await q(`machines?id=eq.${caMachId}&select=machine_type`, aTok);
    chk(machBack.body?.[0]?.machine_type === 'overlock', `machine_type stored -> ${machBack.body?.[0]?.machine_type}`);

    const partner = await write('POST', 'finishing_partners', aTok, { name: `CA-P-${caStamp}`, stage_type: 'press', rate_basis: 'per_repeat', rate: 8, is_extended_partner: true });
    caPartnerId = Array.isArray(partner.body) ? partner.body[0]?.id : null;
    const partnerBack = await q(`finishing_partners?id=eq.${caPartnerId}&select=is_extended_partner`, aTok);
    chk(partnerBack.body?.[0]?.is_extended_partner === true, 'is_extended_partner stored');

    // Constraints refuse nonsense.
    chk(refused(await write('POST', 'machines', aTok, { name: `CA-BAD-M-${caStamp}`, machine_type: 'hoverboard' })),
      'machine_type outside the allowed set is rejected');
    chk(refused(await write('POST', 'suppliers', aTok, { name: `CA-BAD-S-${caStamp}`, payment_day: 32 })),
      'payment_day outside 1..31 is rejected');
    chk(refused(await write('POST', 'vendors', aTok, { name: `CA-BAD-V-${caStamp}`, price: -5 })),
      'negative vendor price is rejected');

    // Cross-tenant + module gate hold on the new columns.
    chk((await q(`machines?id=eq.${caMachId}&select=id`, bTok)).body?.length === 0,
      `Beta cannot read Alpha's machine with the new machine_type`);
    chk(refused(await write('POST', 'machines', bTok, { name: `CA-BETA-M-${caStamp}`, machine_type: 'cutter' })),
      'Beta still cannot create machines (machine_workforce off)');
  }

  console.log('\n=== 44. manager/labour roles + employee_compensation RLS ===');
  {
    const roles = await q('roles?select=key', aTok);
    const roleKeys = (roles.body ?? []).map((r) => r.key);
    chk(roleKeys.includes('manager') && roleKeys.includes('labour') && roleKeys.includes('worker'),
      `roles table has manager + labour -> ${roleKeys.join(', ')}`);

    // Read scope: company_admin + accountant yes; worker/qa/Beta no.
    chk((await q('employee_compensation?select=id', aTok)).status === 200,
      'company_admin can read employee_compensation');
    chk((await q('employee_compensation?select=id', AP.acc)).status === 200,
      'accountant can read employee_compensation');
    const wComp = await q('employee_compensation?select=id', tokens['worker@alpha.test']);
    chk(Array.isArray(wComp.body) && wComp.body.length === 0,
      `worker cannot read employee_compensation -> ${JSON.stringify(wComp.body)}`);
    const qaComp = await q('employee_compensation?select=id', tokens['qa@alpha.test']);
    chk(Array.isArray(qaComp.body) && qaComp.body.length === 0,
      `qa cannot read employee_compensation -> ${JSON.stringify(qaComp.body)}`);
    // Beta's owner legitimately reads BETA's own compensation rows — the policy
    // is `factory_id = current_factory_id()`, not "nobody sees anything". The
    // old assertion here was `length === 0`, which only held while Beta happened
    // to have no rows seeded; once it did, this failed as a phantom leak. What
    // actually matters is that NONE of what comes back is Alpha's.
    const bComp = await q('employee_compensation?select=id,factory_id', bTok);
    const leaked = (bComp.body ?? []).filter((r) => r.factory_id !== BETA);
    chk(Array.isArray(bComp.body) && leaked.length === 0,
      `Beta owner reads only Beta's employee_compensation (${bComp.body?.length ?? 0} own row(s), ${leaked.length} of Alpha's)`);

    // No direct write path at all — the RPCs are the only way in.
    chk(refused(await write('POST', 'employee_compensation', aTok, {
      factory_id: ALPHA, user_id: '00000000-0000-0000-0000-000000000000', role: 'worker',
      salary_type: 'per_month', salary_amount: 30000,
    })), 'direct INSERT into employee_compensation is refused (RPCs only)');
  }

  console.log('\n=== 45. create_employee makes login + profile + compensation in one shot ===');
  let mgrId = null;
  let wrkId = null;
  {
    const empEmail = `ca-mgr-${caStamp}@alpha.test`;
    const mgr = await rpc('create_employee', aTok, {
      p_email: empEmail, p_password: 'Password123!', p_display_name: `CA Mgr ${caStamp}`,
      p_role: 'manager', p_salary_type: 'per_month', p_salary_amount: 5000,
    });
    mgrId = mgr.body?.id ?? null;
    chk(mgr.status === 200 && !!mgrId, `create_employee(manager) -> ${mgrId ? 'ok' : JSON.stringify(mgr.body)?.slice(0, 120)}`);

    // The new login works immediately and resolves the right role + factory.
    const mgrLogin = await login(empEmail, 'Password123!');
    chk(!!mgrLogin?.access_token, 'new employee can sign in immediately');
    if (mgrLogin?.access_token) {
      const mp = (await q(`profiles?id=eq.${mgrId}&select=role,factory_id,is_active`, mgrLogin.access_token)).body?.[0];
      chk(mp?.role === 'manager' && mp?.factory_id === ALPHA && mp?.is_active === true,
        `new profile: manager @ Alpha, active -> ${JSON.stringify(mp)}`);
    }

    const comp = await q(`employee_compensation?user_id=eq.${mgrId}&select=salary_type,salary_amount`, aTok);
    chk(comp.body?.[0]?.salary_type === 'per_month' && Number(comp.body?.[0]?.salary_amount) === 5000,
      `compensation row: per_month 5000 -> ${JSON.stringify(comp.body?.[0])}`);

    // per_stitch workers get their rate snapshotted onto the profile.
    const wEmail = `ca-wrk-${caStamp}@alpha.test`;
    const wrk = await rpc('create_employee', aTok, {
      p_email: wEmail, p_password: 'Password123!', p_display_name: `CA Wrk ${caStamp}`,
      p_role: 'worker', p_salary_type: 'per_stitch', p_salary_amount: 0.75,
    });
    wrkId = wrk.body?.id ?? null;
    chk(!!wrkId, `create_employee(worker per_stitch) -> ${wrkId ? 'ok' : JSON.stringify(wrk.body)?.slice(0, 120)}`);
    const stitchRate = (await q(`profiles?id=eq.${wrkId}&select=stitch_rate`, aTok)).body?.[0]?.stitch_rate;
    chk(Number(stitchRate) === 0.75, `profiles.stitch_rate snapshotted for per_stitch worker -> ${stitchRate}`);

    // Bad inputs refused.
    const dup = await rpc('create_employee', aTok, {
      p_email: empEmail, p_password: 'Password123!', p_display_name: 'Dup',
      p_role: 'manager', p_salary_type: 'per_month', p_salary_amount: 1,
    });
    chk(dup.status >= 400, `duplicate email refused -> HTTP ${dup.status} ${JSON.stringify(dup.body)?.slice(0, 80)}`);
    const weak = await rpc('create_employee', aTok, {
      p_email: `ca-weak-${caStamp}@alpha.test`, p_password: 'x', p_display_name: 'Weak',
      p_role: 'manager', p_salary_type: 'per_month', p_salary_amount: 1,
    });
    chk(weak.status >= 400, `short password refused -> HTTP ${weak.status}`);
    chk(refused(await rpc('create_employee', AP.acc, {
      p_email: `ca-acc-${caStamp}@alpha.test`, p_password: 'Password123!', p_display_name: 'Acc',
      p_role: 'manager', p_salary_type: 'per_month', p_salary_amount: 1,
    })), 'accountant cannot create employees');
    chk(refused(await rpc('create_employee', tokens['worker@alpha.test'], {
      p_email: `ca-w-${caStamp}@alpha.test`, p_password: 'Password123!', p_display_name: 'W',
      p_role: 'manager', p_salary_type: 'per_month', p_salary_amount: 1,
    })), 'worker cannot create employees');

    // Cross-tenant is not "refused" — it is scoped: Beta's RPC lands in Beta.
    const betaEmp = await rpc('create_employee', bTok, {
      p_email: `ca-beta-${caStamp}@beta.test`, p_password: 'Password123!', p_display_name: 'CA Beta',
      p_role: 'labour', p_salary_type: 'per_month', p_salary_amount: 3000,
    });
    const betaEmpId = betaEmp.body?.id ?? null;
    chk(!!betaEmpId, `Beta owner creates its own labour login -> ${betaEmpId ? 'ok' : JSON.stringify(betaEmp.body)?.slice(0, 100)}`);
    if (betaEmpId) {
      const bp = (await q(`profiles?id=eq.${betaEmpId}&select=factory_id,role`, bTok)).body?.[0];
      chk(bp?.factory_id === BETA && bp?.role === 'labour',
        `Beta-created employee scoped to Beta, role labour -> ${JSON.stringify(bp)}`);
      await rpc('deactivate_employee', bTok, { p_user_id: betaEmpId });
    }
  }

  console.log('\n=== 46. Masters stat panels are factory-scoped (0030) ===');
  {
    const alphaClients = (await q('vendors?select=id&deleted_at=is.null', aTok)).body?.length ?? 0;
    chk(Number((await rpc('master_client_stats', aTok, {})).body?.[0]?.total_clients) === alphaClients,
      `Alpha client stats match its own vendor count (${alphaClients})`);
    const betaClients = (await q('vendors?select=id&deleted_at=is.null', bTok)).body?.length ?? 0;
    chk(Number((await rpc('master_client_stats', bTok, {})).body?.[0]?.total_clients) === betaClients,
      `Beta client stats match its own vendor count (${betaClients}) — no cross-tenant leakage`);

    const alphaSuppliers = (await q('suppliers?select=id&deleted_at=is.null', aTok)).body?.length ?? 0;
    chk(Number((await rpc('master_supplier_stats', aTok, {})).body?.[0]?.total_suppliers) === alphaSuppliers,
      `Alpha supplier stats match its own supplier count (${alphaSuppliers})`);
    const alphaMachines = (await q('machines?select=id&deleted_at=is.null', aTok)).body?.length ?? 0;
    chk(Number((await rpc('master_machine_stats', aTok, {})).body?.[0]?.total_machines) === alphaMachines,
      `Alpha machine stats match its own machine count (${alphaMachines})`);
    const alphaPartners = (await q('finishing_partners?select=id&deleted_at=is.null', aTok)).body?.length ?? 0;
    chk(Number((await rpc('master_partner_stats', aTok, {})).body?.[0]?.total_partners) === alphaPartners,
      `Alpha partner stats match its own partner count (${alphaPartners})`);

    const machRow = (await rpc('master_machine_stats', aTok, {})).body?.[0];
    chk(machRow?.shifts_closed >= 0 && typeof Number(machRow?.run_minutes) === 'number',
      `machine health fields present -> shifts ${machRow?.shifts_closed}, uptime ${machRow?.uptime_pct}%`);
  }

  console.log('\n=== 47. Salary run branches by salary_type (0030) ===');
  if (mgrId) {
    const summary = await rpc('acct_salary_run_summary', AP.acc, {});
    const mgrRow = asArr(summary.body).find((r) => r.worker_id === mgrId);
    chk(mgrRow?.salary_type === 'per_month' && Number(mgrRow?.total_net) === 5000 && mgrRow?.has_pending === true,
      `per_month row in summary: ${mgrRow?.salary_type} net ${mgrRow?.total_net} pending ${mgrRow?.has_pending}`);

    const fin = await rpc('acct_finalize_salary_run', AP.acc, { p_period: null, p_worker_ids: [mgrId] });
    chk(fin.status === 200 && Number(fin.body?.fixed_salary_count) === 1,
      `finalize posts the fixed row -> ${JSON.stringify(fin.body)}`);
    const fixedRow = await q(`worker_ledger?worker_id=eq.${mgrId}&shift_id=is.null&select=shift_id,net,status`, AP.acc);
    chk(fixedRow.body?.[0]?.shift_id === null && Number(fixedRow.body?.[0]?.net) === 5000 && fixedRow.body?.[0]?.status === 'finalized',
      `fixed-salary ledger row: shift_id null, net 5000, finalized -> ${JSON.stringify(fixedRow.body?.[0])}`);

    const fin2 = await rpc('acct_finalize_salary_run', AP.acc, { p_period: null, p_worker_ids: [mgrId] });
    chk(Number(fin2.body?.fixed_salary_count) === 0 && Number(fin2.body?.finalized_count) === 0,
      're-finalizing the same worker creates nothing new');

    const summary2 = await rpc('acct_salary_run_summary', AP.acc, {});
    const mgrRow2 = asArr(summary2.body).find((r) => r.worker_id === mgrId);
    chk(mgrRow2?.has_pending === false, 'fixed row is no longer pending after finalize');

    // Beta's module gate + tenancy hold on the rebuilt functions.
    const bAccTok = tokens['accountant@beta.test'];
    chk(refused(await rpc('acct_finalize_salary_run', bAccTok, { p_period: null, p_worker_ids: [mgrId] })),
      'Beta accountant finalizing Alpha\'s worker is refused');
    const bSum = await rpc('acct_salary_run_summary', bAccTok, {});
    chk(asArr(bSum.body).every((r) => r.worker_id !== mgrId),
      'Beta salary run shows no Alpha employee rows');
  } else no('no manager created in section 45; skipping section 47');

  console.log('\n=== 48. deactivate_employee toggles the login off, history intact ===');
  if (mgrId) {
    const deact = await rpc('deactivate_employee', aTok, { p_user_id: mgrId });
    chk(deact.status === 200 || deact.status === 204, `deactivate_employee -> HTTP ${deact.status}`);
    const after = (await q(`profiles?id=eq.${mgrId}&select=is_active`, aTok)).body?.[0];
    chk(after?.is_active === false, 'profile is_active flipped to false');
    const compAfter = await q(`employee_compensation?user_id=eq.${mgrId}&select=salary_type`, aTok);
    chk(compAfter.body?.[0]?.salary_type === 'per_month', 'compensation history retained after deactivation');

    const cross = await rpc('deactivate_employee', bTok, { p_user_id: mgrId });
    chk(cross.status >= 400, `Beta owner deactivating Alpha's employee is refused -> HTTP ${cross.status}`);
    const still = (await q(`profiles?id=eq.${mgrId}&select=is_active`, aTok)).body?.[0];
    chk(still?.is_active === false, 'employee still deactivated (Beta attempt changed nothing)');
  } else no('no manager created in section 45; skipping section 48');

  console.log('\n=== 49. Anonymous blocked on the new 0030 surface ===');
  for (const t of ['employee_compensation']) {
    const r = await q(`${t}?select=*`, KEY);
    chk(Array.isArray(r.body) && r.body.length === 0, `anon read ${t} -> ${JSON.stringify(r.body)}`);
  }
  chk(refused(await rpc('create_employee', KEY, { p_email: 'anon@x.test', p_password: 'Password123!', p_display_name: 'Anon', p_role: 'manager', p_salary_type: 'per_month', p_salary_amount: 1 })),
    'anonymous create_employee is refused');

  console.log('\n=== 50. Accountant dashboard: photo rule, bill types, scope (0031) ===');
  let billExpenseId = null;
  {
    const accA = tokens['accountant@alpha.test'];
    const accB = tokens['accountant@beta.test'];
    const saysPhoto = (r) => /photo/i.test(JSON.stringify(r.body ?? ''));

    // --- The photo rule. assert_proof_photo runs before any lookup, so these
    //     refusals are the photo rule firing and not a missing-record 404. ---
    const noPhotoExpense = await rpc('acct_add_expense', accA, {
      p_category: 'maintenance', p_amount: 100, p_proof_url: null,
    });
    chk(noPhotoExpense.status >= 400 && saysPhoto(noPhotoExpense),
      `expense without a photo is refused -> HTTP ${noPhotoExpense.status}`);

    const noPhotoPay = await rpc('acct_record_payment', accA, {
      p_ref_type: 'invoice', p_ref_id: ALPHA, p_amount: 100, p_proof_url: '  ',
    });
    chk(noPhotoPay.status >= 400 && saysPhoto(noPhotoPay),
      `payment without a photo is refused (blank counts as none) -> HTTP ${noPhotoPay.status}`);

    const noPhotoPartner = await rpc('acct_pay_partner', accA, {
      p_partner_id: ALPHA, p_amount: 100, p_proof_url: null,
    });
    chk(noPhotoPartner.status >= 400 && saysPhoto(noPhotoPartner),
      `partner payment without a photo is refused -> HTTP ${noPhotoPartner.status}`);

    const noPhotoInvoice = await rpc('fm_generate_invoice', A.fm, {
      p_order_id: ALPHA, p_amount: 100, p_photo_url: null,
    });
    chk(noPhotoInvoice.status >= 400 && saysPhoto(noPhotoInvoice),
      `invoice without a photo is refused -> HTTP ${noPhotoInvoice.status}`);

    // --- Bill types are free text, remembered for reuse. ---
    const billName = `verify-electricity-${stamp}`;
    const noSubtype = await rpc('acct_add_expense', accA, {
      p_category: 'bills', p_amount: 500, p_proof_url: 'alpha/bill.jpg',
    });
    chk(noSubtype.status >= 400, `a bill with no type named is refused -> HTTP ${noSubtype.status}`);

    const bill = await rpc('acct_add_expense', accA, {
      p_category: 'bills', p_amount: 500, p_proof_url: 'alpha/bill.jpg',
      p_description: 'verification run', p_bill_subtype: billName,
    });
    billExpenseId = bill.body?.id ?? null;
    chk(bill.status === 200 && bill.body?.bill_subtype === billName,
      `bill recorded with a brand-new type -> ${bill.body?.bill_subtype}`);

    const subtypes = await rpc('acct_bill_subtypes', accA);
    chk(Array.isArray(subtypes.body) && subtypes.body.some((s) => s.bill_subtype === billName),
      'the new bill type is remembered and suggested back');

    const billRows = await rpc('acct_payable_expenses', accA, { p_category: 'bills' });
    chk(Array.isArray(billRows.body) && billRows.body.some((b) => b.expense_id === billExpenseId),
      'the bill appears under Payable -> Bills');

    // Beta must not see Alpha's bill type (its finance module is off entirely).
    const betaSubtypes = await rpc('acct_bill_subtypes', accB);
    chk(betaSubtypes.status >= 400 ||
        !(betaSubtypes.body ?? []).some((s) => s.bill_subtype === billName),
      'Beta cannot see Alpha bill types');

    // --- Read RPCs: factory-scoped, module-gated, role-gated. ---
    const clients = await rpc('acct_client_summary', accA);
    const alphaVendors = await q('vendors?deleted_at=is.null&select=id', accA);
    chk(Array.isArray(clients.body) && clients.body.length === (alphaVendors.body ?? []).length,
      `client summary covers exactly Alpha's ${(alphaVendors.body ?? []).length} clients`);

    chk((await rpc('acct_client_summary', accB)).status >= 400,
      'Beta accountant is refused: finance module off for that factory');
    chk((await rpc('acct_employee_summary', tokens['worker@alpha.test'])).status >= 400,
      'a worker cannot read the employee salary summary');
    chk(refused(await rpc('acct_receivable_summary', KEY)), 'anonymous is refused on receivables');

    // --- Employees box covers every role, not just workers. ---
    const emps = await rpc('acct_employee_summary', accA);
    const roles = new Set((emps.body ?? []).map((e) => e.role));
    chk(roles.size > 1 && !(roles.size === 1 && roles.has('worker')),
      `employee summary spans ${roles.size} role(s), not workers only`);
    if (mgrId) {
      const mgr = (emps.body ?? []).find((e) => e.user_id === mgrId);
      chk(mgr?.salary_type === 'per_month' && Number(mgr?.total_salary) === 5000,
        'the per_month manager carries the same figure the salary run computed');
    }

    // --- Machine hours reconcile against the machine's own shift records. ---
    const machines = await rpc('acct_machine_summary', accA);
    const withShifts = (machines.body ?? []).find((m) => m.closed_shifts > 0);
    if (withShifts) {
      const raw = await q(
        `shifts?machine_id=eq.${withShifts.machine_id}&closed_at=not.is.null&select=opened_at,closed_at`,
        accA
      );
      const byHand = (raw.body ?? []).reduce(
        (sum, s) => sum + (new Date(s.closed_at) - new Date(s.opened_at)) / 60000, 0
      );
      chk(Math.abs(byHand - Number(withShifts.total_minutes)) < 0.2,
        `machine ${withShifts.name}: ${Number(withShifts.total_minutes).toFixed(1)} min matches its shift records (${byHand.toFixed(1)})`);
    } else no('no machine with a closed shift; cannot reconcile hours this run');

    // --- Receivable reconciles: pending = billed − collected on unpaid invoices. ---
    const recv = await rpc('acct_receivable_summary', accA);
    const invs = await q('invoices?status=neq.cancelled&select=amount,status', accA);
    const billed = (invs.body ?? []).reduce((s, i) => s + Number(i.amount), 0);
    chk(Math.abs(billed - Number(recv.body?.[0]?.total_income ?? -1)) < 0.01,
      'receivable total income equals the sum of live invoices');
  }

  console.log('\n=== 51. Order Taker returns board is scoped and read-only (0032) ===');
  {
    // Scope: the board only shows orders THIS order taker created.
    const board = await rpc('ot_return_repeats', A.ot);
    chk(board.status === 200 && Array.isArray(board.body),
      `ot_return_repeats -> HTTP ${board.status}`);

    const myOrders = new Set(
      ((await q('orders?select=id,created_by', A.ot)).body ?? [])
        .filter((o) => o.created_by === userIds['order@alpha.test'])
        .map((o) => o.id)
    );
    chk((board.body ?? []).every((r) => myOrders.has(r.order_id)),
      'every returns row belongs to an order this order taker created');

    // Buckets are exclusive and mean what 0032 (+ 0036's ot_return_confirmed_at
    // path, + 0058's awaiting_qa_final) say they mean: completed either because
    // production reached the end, or because the order taker confirmed the
    // physical handback.
    //
    // `awaiting_qa_final` belongs in this list — 0056 inserted it between the
    // Floor Manager's final check and QA's real final pass, and 0058 taught the
    // board to treat it as finished. Without it here, a piece the Floor Manager
    // has just signed off reads as still outstanding.
    //
    // Scoped to `kind === 'finishing'`: an Initial-QA rejection is closed by its
    // own rules — the order taker confirming the handback, or QA writing the
    // piece off entirely (0063/0064) — and has no production status to compare.
    const FINISHED = ['awaiting_final_qa', 'awaiting_qa_final', 'completed'];
    chk((board.body ?? []).filter((r) => r.kind === 'finishing').every((r) =>
      (r.bucket === 'completed') ===
        (FINISHED.includes(r.current_status) || !!r.ot_return_confirmed_at)),
      'active/completed buckets match repeat status (finishing side)');

    const handover = await rpc('ot_handover_orders', A.ot);
    chk(handover.status === 200 && (handover.body ?? []).every((o) =>
      o.bucket === 'delivered' ? !!o.delivered_at || o.status === 'completed' : true),
      `ot_handover_orders -> HTTP ${handover.status}`);

    // Cross-tenant: Beta's order taker sees none of Alpha's rows.
    const betaBoard = await rpc('ot_return_repeats', B.ot);
    const alphaCodes = new Set((board.body ?? []).map((r) => r.repeat_code));
    chk(betaBoard.status >= 400 ||
        !(betaBoard.body ?? []).some((r) => alphaCodes.has(r.repeat_code)),
      'Beta order taker sees none of Alpha\'s repeats');

    // Role: the board is the order taker's (and the owner's), nobody else's.
    chk((await rpc('ot_return_repeats', A.qa)).status >= 400,
      'QA is refused on the order taker returns board');
    chk(refused(await rpc('ot_handover_orders', KEY)), 'anonymous is refused on the handover board');
  }

  console.log('\n=== 52. Order Taker "Complete return" is scoped and one-shot (0036) ===');
  {
    // The "active" bucket would otherwise be empty here, so manufacture one
    // handed-off repeat. This used to call `dp_confirm_handoff` — Phase 6's
    // handoff RPC — which 0063 DROPPED: it moved orders into production without
    // putting their repeats in the stage loop, and stranded whatever it did not
    // touch. The same physical state is now reached through the real 0056 loop,
    // which is also a better test: it exercises the path production uses.
    const spareRepeats = await q(
      `repeats?select=id,repeat_code,current_status,sheets!inner(order_id)&sheets.order_id=eq.${alphaRun.orderId}&order=repeat_code`, A.fm);
    const partnerRow = await q('finishing_partners?select=id&deleted_at=is.null&limit=1', A.fm);
    const partnerId = partnerRow.body?.[0]?.id;
    const spare = (spareRepeats.body ?? []).find((r) =>
      ['in_progress', 'stage_qa', 'handover_for_delivery', 'awaiting_dp_collection', 'handed_over']
        .includes(r.current_status));

    if (spare && partnerId) {
      const step = {
        in_progress: () => rpc('fm_send_to_stage_qa', A.fm, { p_repeat_id: spare.id }),
        stage_qa: () => rpc('qa_pass_stage_qa', A.qa, { p_repeat_id: spare.id }),
        handover_for_delivery: () => rpc('fm_hand_over_stage', A.fm, { p_repeat_id: spare.id }),
        awaiting_dp_collection: () =>
          rpc('dp_collect_from_floor', A.dp, { p_repeat_id: spare.id, p_photo_url: 'alpha/handoff/test.jpg' }),
        handed_over: () => rpc('dp_send_to_partner', A.dp, { p_repeat_id: spare.id, p_partner_id: partnerId }),
      };
      let cur = spare.current_status;
      for (let i = 0; i < 8 && cur !== 'handed_off'; i++) {
        const f = step[cur];
        if (!f) break;
        cur = (await f()).body?.current_status;
      }
      chk(cur === 'handed_off',
        `drove ${spare.repeat_code} out to a partner through the 0056 loop to exercise Complete Return -> ${cur}`);
    } else {
      no('no drivable repeat / finishing partner to manufacture a handoff with');
    }

    const board = await rpc('ot_return_repeats', A.ot);
    // The board now unions finishing returns with Initial-QA rejections (0054),
    // and only the finishing kind has a repeat_id for ot_complete_return to
    // take. Section 53 covers the rejection kind.
    const active = (board.body ?? []).find((r) => r.bucket === 'active' && r.kind === 'finishing');

    if (active) {
      // Role: only order_taker/company_admin may call this at all.
      chk((await rpc('ot_complete_return', A.qa, { p_repeat_id: active.repeat_id })).status >= 400,
        'QA is refused on ot_complete_return');

      // Cross-tenant: Beta's order taker cannot complete an Alpha repeat.
      chk(refused(await rpc('ot_complete_return', B.ot, { p_repeat_id: active.repeat_id })),
        "Beta order taker is refused on Alpha's repeat");

      // Positive: the owning order taker completes it, and current_status is untouched.
      // 0057: a return cannot be completed without proof it went back to the
      // vendor. Prove the refusal first, then complete it properly.
      chk((await rpc('ot_complete_return', A.ot, { p_repeat_id: active.repeat_id, p_photo_url: '  ' })).status >= 400,
        'ot_complete_return without a photo is refused (0057)');
      const done = await rpc('ot_complete_return', A.ot,
        { p_repeat_id: active.repeat_id, p_photo_url: 'alpha/vt-vendor-return.jpg' });
      chk(done.status === 200 && !!done.body?.ot_return_confirmed_at,
        `ot_complete_return -> HTTP ${done.status}, ot_return_confirmed_at set`);
      chk(done.body?.current_status === active.current_status,
        'current_status is unchanged by ot_complete_return (only the board bucket moves)');

      // The board reflects it immediately: same repeat now buckets as completed.
      const after = await rpc('ot_return_repeats', A.ot);
      const moved = (after.body ?? []).find((r) => r.repeat_id === active.repeat_id);
      chk(moved?.bucket === 'completed', 'the completed repeat now shows in the completed bucket');

      // One-shot: calling it again on the same repeat is refused (no longer active).
      chk((await rpc('ot_complete_return', A.ot,
            { p_repeat_id: active.repeat_id, p_photo_url: 'alpha/vt-vendor-return-2.jpg' })).status >= 400,
        'a second ot_complete_return on the same repeat is refused (with a valid photo, so it is the one-shot rule refusing it)');
    } else {
      no('no active-bucket return this run to exercise ot_complete_return against');
    }
  }

  console.log('\n=== 53. Initial-QA rejections are on the returns board, scoped the same way (0054) ===');
  {
    // A piece rejected at Stage 2 never gets a repeat and never gets a handoff,
    // so before 0054 it could not reach this board at all.
    //
    // This needs its OWN order: qa_reject_piece only runs at `awaiting_coding`,
    // and alphaRun left that status back in section 20. Reusing alphaRun's
    // vendor keeps the row inside cleanup_test_data.sql's 'Spine %' net.
    const rejOrder = await rpc('create_order', A.ot, {
      p_vendor_id: alphaRun.vendorId,
      p_sheets: [{ color_assignment: 'Reject probe', repeats_count: 2, thread_color_codes: ['RED-01'], stitch_count: 1000 }],
    });
    const rejOrderId = rejOrder.body?.id;
    let damageId = null;
    let rejSheetId = null;

    if (rejOrderId) {
      await rpc('submit_order', A.ot, { p_order_id: rejOrderId });
      await rpc('qa_accept_cloth', A.qa, { p_order_id: rejOrderId });
      rejSheetId = (await q(`sheets?order_id=eq.${rejOrderId}&select=id&limit=1`, A.qa)).body?.[0]?.id;

      const rejected = await rpc('qa_reject_piece', A.qa, {
        p_order_id: rejOrderId, p_sheet_id: rejSheetId,
        p_damage_type: 'stains', p_photo_url: 'alpha/qa/reject.jpg',
        p_note: 'tenancy probe', p_scope: 'piece',
      });
      damageId = rejected.body?.damage_ids?.[0] ?? null;
      chk(!!damageId, `rejected a piece on ${rejOrder.body?.order_code} -> ${damageId ? 'damage recorded' : rejected.body?.message}`);
    } else {
      no('could not create an order to reject a piece on');
    }

    const board = await rpc('ot_return_repeats', A.ot);
    const rejections = (board.body ?? []).filter((r) => r.kind === 'qa_rejection');
    chk((board.body ?? []).every((r) => r.kind === 'finishing' || r.kind === 'qa_rejection'),
      `every board row declares a kind (${rejections.length} rejection(s) of ${board.body?.length ?? 0})`);
    chk(rejections.every((r) => r.repeat_id === null && !!r.entry_id),
      'rejection rows carry no repeat_id (none was ever coded) but always an entry_id');
    chk(rejections.every((r) => !!r.damage_id && !!r.reason),
      'rejection rows carry the damage id and reason the screen renders');

    const mineRejection = rejections.find((r) => r.entry_id === damageId);
    chk(mineRejection?.bucket === 'active',
      `the piece just rejected lands in ACTIVE returns (bucket=${mineRejection?.bucket})`);

    // The piece number must be stable, not an artifact of a created_at tie
    // (0055). Two reads of the same board have to agree.
    const board2 = await rpc('ot_return_repeats', A.ot);
    const indexOf = (rows) => Object.fromEntries((rows ?? []).map((r) => [r.entry_id, r.piece_index]));
    const i1 = indexOf(board.body), i2 = indexOf(board2.body);
    chk(Object.keys(i1).every((k) => i1[k] === i2[k]),
      'piece numbering is stable across reads (no created_at-tie drift)');

    // Scope: still only this order taker's own orders.
    const myOrders = new Set(
      ((await q('orders?select=id,created_by', A.ot)).body ?? [])
        .filter((o) => o.created_by === userIds['order@alpha.test'])
        .map((o) => o.id)
    );
    chk(rejections.every((r) => myOrders.has(r.order_id)),
      'every rejection row belongs to an order this order taker created');

    // Cross-tenant.
    const betaBoard = await rpc('ot_return_repeats', B.ot);
    const alphaEntries = new Set((board.body ?? []).map((r) => r.entry_id));
    chk(betaBoard.status >= 400 || !(betaBoard.body ?? []).some((r) => alphaEntries.has(r.entry_id)),
      "Beta order taker sees none of Alpha's rejection rows");

    if (damageId) {
      chk((await rpc('ot_complete_qa_return', A.qa, { p_damage_id: damageId })).status >= 400,
        'QA is refused on ot_complete_qa_return');
      chk(refused(await rpc('ot_complete_qa_return', B.ot, { p_damage_id: damageId })),
        "Beta order taker is refused on Alpha's rejected piece");
      chk(refused(await rpc('ot_complete_qa_return', KEY, { p_damage_id: damageId })),
        'anonymous is refused on ot_complete_qa_return');

      // Positive, then one-shot — the same contract ot_complete_return holds.
      chk((await rpc('ot_complete_qa_return', A.ot, { p_damage_id: damageId, p_photo_url: '' })).status >= 400,
        'ot_complete_qa_return without a photo is refused (0057)');
      const done = await rpc('ot_complete_qa_return', A.ot,
        { p_damage_id: damageId, p_photo_url: 'alpha/vt-qa-return.jpg' });
      chk(done.status === 200 && !!done.body?.ot_return_confirmed_at,
        `ot_complete_qa_return -> HTTP ${done.status}, ot_return_confirmed_at set`);
      const after = await rpc('ot_return_repeats', A.ot);
      chk((after.body ?? []).find((r) => r.entry_id === damageId)?.bucket === 'completed',
        'the rejected piece moved Active -> Completed returns');
      chk((await rpc('ot_complete_qa_return', A.ot,
            { p_damage_id: damageId, p_photo_url: 'alpha/vt-qa-return-2.jpg' })).status >= 400,
        'a second ot_complete_qa_return on the same piece is refused (with a valid photo)');
    } else {
      no('no repeat_qa rejection to exercise ot_complete_qa_return against');
    }

    // A finishing repeat id must NOT be accepted as a damage id, and vice versa
    // — the two completions are separate functions precisely to keep that so.
    const anyRepeat = (board.body ?? []).find((r) => r.kind === 'finishing');
    if (anyRepeat) {
      chk((await rpc('ot_complete_qa_return', A.ot, { p_damage_id: anyRepeat.repeat_id })).status >= 400,
        'passing a repeat id to the QA-rejection completion is refused');
    }
  }

  // ---- Phase 3 cleanup ----
  //
  // Submitted orders are deliberately NOT deletable through the API: the RLS
  // delete policy only matches status='draft', because an order with coded
  // repeats and history is a business record, not scratch data. That is correct
  // behaviour, so this run leaves its orders behind rather than weakening the
  // model to tidy up after itself.
  //
  // To clear accumulated test rows, run (via the session pooler, as the DB owner):
  //   supabase/maintenance/cleanup_test_data.sql
  console.log('\n=== cleanup (phase 3) ===');
  const leftBehind = [];
  for (const [oid, code, tok] of [
    [alphaRun.orderId, alphaRun.orderCode, A.ot],
    [shortId, 'shortfall order', A.ot],
    [betaRun.orderId, betaRun.orderCode, B.ot],
  ]) {
    if (!oid) continue;
    const d = await write('DELETE', `orders?id=eq.${oid}`, tok);
    if (refused(d)) leftBehind.push(code);
  }
  if (leftBehind.length) {
    console.log(`  kept (submitted orders are not API-deletable, by design): ${leftBehind.join(', ')}`);
    console.log('  run supabase/maintenance/cleanup_test_data.sql to clear test rows');
  }
  // Vendors created by this run archive cleanly only if unreferenced; ignore failures.
  for (const [vid, tok] of [[alphaRun.vendorId, aTok], [betaRun.vendorId, bTok]]) {
    if (vid) await write('DELETE', `vendors?id=eq.${vid}`, tok);
  }

  // ---- cleanup: remove rows this run created ----
  console.log('\n=== cleanup ===');
  for (const [table, id] of Object.entries(created)) {
    if (table === 'finishing_partners') {
      await write('PATCH', `${table}?id=eq.${id}`, aTok, { user_id: null });
    }
    const r = await write('DELETE', `${table}?id=eq.${id}`, aTok);
    console.log(`  removed ${table}/${String(id).slice(0, 8)} -> HTTP ${r.status}`);
  }

  // ---- cleanup: 0030 masters rows ----
  for (const [table, id] of [['vendors', caVendId], ['suppliers', caSupId], ['machines', caMachId], ['finishing_partners', caPartnerId]]) {
    if (!id) continue;
    if (table === 'finishing_partners') await write('PATCH', `${table}?id=eq.${id}`, aTok, { user_id: null });
    const r = await write('DELETE', `${table}?id=eq.${id}`, aTok);
    console.log(`  removed ${table}/${String(id).slice(0, 8)} -> HTTP ${r.status}`);
  }

  // ---- cleanup: the 0031 verification bill ----
  if (billExpenseId) {
    const r = await write('DELETE', `expenses?id=eq.${billExpenseId}`, aTok);
    console.log(
      refused(r)
        ? '  verification bill kept (expenses are posted records, not API-deletable)'
        : `  removed expenses/${String(billExpenseId).slice(0, 8)} -> HTTP ${r.status}`
    );
  }

  // Employees are real auth logins — not API-deletable, so they are deactivated
  // (inert, history kept) exactly as the app's own flow would leave them.
  for (const uid of [mgrId, wrkId]) {
    if (uid) await rpc('deactivate_employee', aTok, { p_user_id: uid });
  }
  if (mgrId || wrkId) {
    console.log('  deactivated 0030 test logins (auth users cannot be API-deleted)');
  }

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
