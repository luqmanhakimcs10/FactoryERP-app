/**
 * Which migrations are actually applied to the live Supabase project?
 *
 *   npm run check:migrations
 *
 * The migrations folder says what SHOULD be there; this says what IS. The two
 * drift the moment a file is added and not pasted into the SQL editor, and the
 * symptom is always the same confusing shape — a screen erroring on a missing
 * column or "Could not find the function ... in the schema cache".
 *
 * Read-only. It signs in as a seeded user and uses the anon key, exactly the
 * surface the app has. Every RPC probe passes deliberately invalid arguments
 * (zero amounts, nil uuids, bad roles) so the function refuses during validation
 * and writes nothing.
 *
 * TWO PROBE RULES, learned the hard way:
 *   - A function with required arguments CANNOT be probed with `{}`. PostgREST
 *     resolves overloads by argument name, so a no-arg call to a two-arg
 *     function returns "not found" and looks exactly like a missing function.
 *     Always probe with the real parameter names.
 *   - A function body referencing a missing column still EXISTS. plpgsql plans
 *     its SQL at run time, so 0031's functions installed happily while the
 *     columns 0030 was meant to add were absent. "exists" and "works" are
 *     different questions; this script answers the first one.
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

const EMAIL = process.env.CHECK_EMAIL ?? 'owner@alpha.test';
const PASSWORD = process.env.CHECK_PASSWORD ?? 'Password123!';
const NIL = '00000000-0000-0000-0000-000000000000';

let TOKEN = null;

async function login() {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json().catch(() => null);
  return j?.access_token ?? null;
}

/** A column (and therefore its table) exists. */
async function col(table, column) {
  const r = await fetch(`${URL}/rest/v1/${table}?select=${column}&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${TOKEN}` },
  });
  if (r.ok) return { ok: true };
  const body = await r.json().catch(() => null);
  const msg = body?.message ?? `HTTP ${r.status}`;
  if (/Could not find the table|relation .* does not exist/i.test(msg)) {
    return { ok: false, why: `no table ${table}` };
  }
  if (/column .* does not exist/i.test(msg)) return { ok: false, why: `no ${table}.${column}` };
  // RLS returning nothing is a 200 with []; anything else here is unexpected.
  return { ok: false, why: msg.slice(0, 60) };
}

/** At least one row is visible — used for the seed migrations. */
async function rows(table, filter = '') {
  const r = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1${filter}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    return { ok: false, why: (body?.message ?? `HTTP ${r.status}`).slice(0, 60) };
  }
  const body = await r.json().catch(() => []);
  return Array.isArray(body) && body.length > 0
    ? { ok: true }
    : { ok: false, why: `${table} has no rows` };
}

/** The function exists with these parameter names. Never writes. */
async function rpc(name, args = {}) {
  const r = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (r.ok) return { ok: true };
  const body = await r.json().catch(() => null);
  const msg = body?.message ?? '';
  if (body?.code === 'PGRST202' || /Could not find the function/i.test(msg)) {
    return { ok: false, why: `no ${name}()` };
  }
  // Any other error means the function ran and refused — it exists.
  return { ok: true, note: msg.slice(0, 50) };
}

// ---------------------------------------------------------------------------
// One entry per migration that can be detected from outside the database.
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  { file: '0001_foundation_schema', probes: [() => col('factories', 'id'), () => rpc('current_factory_id')] },
  { file: '0002_seed_reference', probes: [() => rows('roles', '&key=eq.accountant')] },
  { file: '0003_seed_dev_users', probes: [() => rows('profiles')] },
  { file: '0005_masters_schema', probes: [() => col('vendors', 'id'), () => col('finishing_partners', 'rate')] },
  { file: '0007_order_spine_schema', probes: [() => col('orders', 'id'), () => col('repeat_stage_history', 'id')] },
  { file: '0008_order_spine_functions', probes: [() => rpc('order_timeline', { p_order_id: NIL })] },
  { file: '0009_seed_thread_stock', probes: [() => rows('thread_stock')] },
  { file: '0012_inventory_schema', probes: [() => col('stock_movements', 'id'), () => col('grns', 'id')] },
  { file: '0013_inventory_functions', probes: [() => rpc('material_issue_queue')] },
  { file: '0016_shift_payroll_schema', probes: [() => col('shifts', 'id'), () => col('worker_ledger', 'id')] },
  { file: '0017_shift_payroll_functions', probes: [() => rpc('fm_shift_close_queue')] },
  { file: '0018_shift_payroll_seed', probes: [() => rows('bonus_slabs')] },
  {
    file: '0019_finishing_schema',
    probes: [
      () => col('sla_alerts', 'id'),
      () => col('orders', 'delivered_at'),
      () => col('repeat_stage_history', 'handed_off_at'),
      () => col('repeat_stage_history', 'partner_id'),
    ],
  },
  {
    file: '0020_finishing_functions',
    probes: [() => rpc('list_sla_alerts'), () => rpc('dp_final_delivery_queue')],
    note: "0020's handoff/collection RPCs were DROPPED by 0063 — they ran in parallel with 0056's stage loop and stranded repeats. SLA alerts and final client delivery are the parts that survived, so they are what prove 0020 ran.",
  },
  {
    file: '0022_phase8_dashboard_schema',
    probes: [() => col('leaves', 'id'), () => rpc('worker_get_active_loan'), () => rpc('partner_get_payment_history')],
    note: 'the leaves TABLE is also created by 0031 — the RPCs are what prove 0022 ran',
  },
  {
    file: '0023_finance_schema',
    probes: [() => col('invoices', 'id'), () => col('partner_ledger', 'id'), () => col('damage_records', 'approval_status')],
  },
  {
    file: '0024_finance_functions',
    probes: [
      () => rpc('acct_record_payment', { p_ref_type: 'invoice', p_ref_id: NIL, p_amount: 0, p_proof_url: null, p_note: null }),
      () => rpc('acct_pay_partner', { p_partner_id: NIL, p_amount: 0, p_proof_url: null, p_note: null }),
      () => rpc('owner_approve_expense', { p_expense_id: NIL, p_approve: false, p_note: null }),
    ],
  },
  { file: '0025_report_functions', probes: [() => rpc('report_company_pl'), () => rpc('report_inventory_leakage')] },
  { file: '0028_super_admin_billing_inventory', probes: [() => col('factories', 'subscription_status'), () => rpc('sa_factory_list')] },
  { file: '0029_partner_earning_posting', probes: [() => rpc('post_partner_earning', { p_repeat_id: NIL, p_order_stage_id: NIL })] },
  {
    file: '0030_company_admin_masters_employees',
    probes: [
      () => col('vendors', 'rate_per_repeat'),
      () => col('suppliers', 'payment_day'),
      () => col('machines', 'machine_type'),
      () => col('finishing_partners', 'is_extended_partner'),
      () => col('employee_compensation', 'salary_type'),
      () => rpc('master_client_stats'),
    ],
  },
  {
    file: '0031_accountant_dashboard',
    probes: [
      () => col('invoices', 'photo_url'),
      () => col('invoices', 'due_date'),
      () => col('expenses', 'bill_subtype'),
      () => col('damage_records', 'quantity_meters'),
      () => rpc('assert_proof_photo', { p_url: '', p_what: 'probe' }),
      () => rpc('acct_client_summary'),
      () => rpc('acct_employee_summary', { p_period: null }),
      () => rpc('acct_bill_subtypes'),
    ],
  },
  { file: '0032_order_taker_returns', probes: [() => rpc('ot_return_repeats'), () => rpc('ot_handover_orders')] },
  {
    file: '0034_qa_repeat_qa',
    probes: [
      () => rpc('qa_pass_piece', { p_order_id: NIL, p_sheet_id: NIL, p_photo_url: null }),
      () => rpc('qa_reject_piece', { p_order_id: NIL, p_sheet_id: NIL, p_damage_type: 'other', p_photo_url: null }),
      () => rpc('qa_complete_repeat_qa', { p_order_id: NIL }),
    ],
  },
  {
    file: '0035_floor_manager_dashboard',
    probes: [
      () => col('material_issues', 'accepted_at'),
      () => rpc('fm_material_issue_queue'),
      () => rpc('fm_decide_leave', { p_leave_id: NIL, p_approve: false }),
    ],
    note: 'fm_accept_inventory is probed under 0040 — its signature changed there (photo required)',
  },
  {
    file: '0036_order_taker_complete_return',
    probes: [() => col('repeats', 'ot_return_confirmed_at'), () => rpc('ot_complete_return', { p_repeat_id: NIL })],
  },
  {
    file: '0037_fm_job_card_line_edit',
    probes: [
      () => rpc('fm_update_job_card_line', { p_job_card_id: NIL, p_line_id: NIL, p_needle_number: 1, p_thread_color_code: 'X' }),
    ],
  },
  {
    file: '0038_fm_vendor_informed',
    probes: [() => col('job_cards', 'vendor_informed_at'), () => rpc('fm_mark_vendor_informed', { p_order_id: NIL })],
  },
  {
    file: '0039_fm_ask_for_material',
    probes: [() => col('job_cards', 'material_requested_at'), () => rpc('fm_ask_for_material', { p_order_id: NIL })],
  },
  {
    file: '0040_fm_accept_inventory_photo',
    probes: [
      () => col('material_issues', 'accepted_photo_url'),
      () => rpc('fm_accept_inventory', { p_material_issue_id: NIL, p_photo_url: null }),
    ],
  },
  {
    file: '0041_machine_selection_pending',
    probes: [
      () => col('orders', 'assigned_machine_id'),
      () => rpc('fm_assign_machine', { p_order_id: NIL, p_machine_id: NIL }),
      () => rpc('fm_shifts_for_date', { p_date: '2020-01-01' }),
    ],
  },
  {
    file: '0042_shift_worker_photo_and_start_time',
    probes: [
      () => col('shifts', 'worker_photo_url'),
      () => col('shifts', 'reported_start_time'),
      () =>
        rpc('fm_open_shift', {
          p_machine_id: NIL,
          p_worker_id: NIL,
          p_order_id: NIL,
          p_open_photo_url: null,
          p_worker_photo_url: null,
        }),
    ],
  },
  {
    file: '0043_stage_tracking_schema',
    probes: [() => col('repeats', 'current_stage_index')],
    note: 'the repeats_current_status_check constraint itself has no client-readable fingerprint',
  },
  { file: '0044_fm_start_production', probes: [() => rpc('fm_start_production', { p_order_id: NIL })] },
  {
    file: '0045_stage_tracking_loop',
    probes: [
      // `fm_start_stage` was a probe here until 0056 DROPPED it — a stage now
      // opens at in_progress on its own and there is no "Start stage" action.
      // Probing for it made this script report 0045 as unrun forever.
      () => rpc('fm_send_to_stage_qa', { p_repeat_id: NIL }),
      () => rpc('qa_pass_stage_qa', { p_repeat_id: NIL }),
      () => rpc('mark_stage_damage', { p_repeat_id: NIL, p_damage_type: 'other' }),
    ],
  },
  {
    file: '0046_low_stock_auto_po',
    probes: [
      () => col('thread_stock', 'reorder_threshold'),
      () => col('thread_stock', 'reorder_quantity'),
      () => rpc('sm_set_reorder_levels', { p_color_code: 'PROBE-COLOR', p_reorder_threshold: -1 }),
    ],
  },
  {
    file: '0048_job_card_design_details',
    probes: [
      () => col('job_cards', 'design_code'),
      () => col('job_cards', 'stitches_per_repeat'),
      () =>
        rpc('fm_save_job_card_design', {
          p_order_id: NIL,
          p_design_code: 'PROBE',
          p_stitches_per_repeat: 0,
        }),
    ],
  },
  { file: '0049_qa_collection_damage_responsible_id', probes: [() => col('damage_records', 'responsible_id')] },
  { file: '0056_stage_handover_loop', probes: [() => rpc('fm_hand_over_stage', { p_repeat_id: NIL }), () => col('repeats', 'current_partner_id')] },
  { file: '0057_assign_machine_and_return_photo', probes: [() => col('damage_records', 'ot_return_photo_url')] },
  { file: '0059_repeat_qa_reject_recheck_loop', probes: [() => col('damage_records', 'recheck_state'), () => rpc('sheet_piece_counts', { p_sheet_id: NIL })] },
  { file: '0061_guard_production_needs_coded_repeats', probes: [() => rpc('assert_order_has_repeats', { p_order_id: NIL })] },
  { file: '0062_partner_active_work_queues_and_qa_photo', probes: [() => rpc('my_queue_summary'), () => col('repeats', 'partner_ready_at')] },
  {
    file: '0063_retire_legacy_handoff_and_write_off',
    probes: [() => rpc('fm_stranded_repeat_orders'), () => col('orders', 'cancel_reason'), () => col('damage_records', 'written_off_at')],
  },
  {
    file: '0050_client_informed_confirms_job_card',
    probes: [() => rpc('fm_mark_vendor_informed', { p_order_id: NIL })],
    note: 'same signature as 0038 — 0050 only changes the body, so this probe cannot tell the two apart. `npm run walk:lifecycle` is what proves the confirm behaviour is live.',
  },
  { file: '0051_fix_zero_requirement_issue', probes: [() => rpc('sm_issue_materials', { p_job_card_id: NIL })] },
  {
    file: '0052_heal_job_card_confirm_gap',
    probes: [() => rpc('fm_ask_for_material', { p_order_id: NIL })],
    note: 'same signature as 0039/0050 — only the body changed (the vendor_informed_at gate is gone). `npm run walk:lifecycle` proves it: a confirmed card must reach material in one press.',
  },
  {
    file: '0053_job_card_add_needle_line',
    probes: [() => rpc('fm_add_job_card_line', { p_job_card_id: NIL, p_thread_color_code: 'PROBE' })],
    note: "0053 also rewrites fm_delete_job_card_line's body (it now renumbers the remaining lines) at the SAME signature as 0048, so no probe can tell those two apart. `npm run walk:lifecycle` proves the renumbering is live.",
  },
  {
    file: '0054_qa_rejections_in_returns',
    probes: [
      () => col('damage_records', 'ot_return_confirmed_at'),
      () => rpc('ot_complete_qa_return', { p_damage_id: NIL }),
    ],
  },

  // ---- Store Manager restructure ----
  {
    file: '0068_inventory_items_generalization',
    probes: [
      () => col('inventory_items', 'item_type'),
      () => col('inventory_items', 'source'),
      () => col('purchase_orders', 'origin'),
      // thread_stock must STILL answer — it is a view over the same rows now,
      // and everything from Phase 3/4 onward reads it.
      () => col('thread_stock', 'quantity_meters'),
      () => rpc('inventory_unit', { p_item_type: 'thread' }),
    ],
  },
  {
    file: '0069_store_manager_restructure_schema',
    probes: [
      () => col('material_requests', 'directed_to'),
      () => col('machine_mounted_items', 'mounted_at'),
      () => col('fm_handover_items', 'leftover_quantity'),
      () => col('purchase_orders', 'assigned_procurement_user_id'),
      () => rpc('sequin_count_from_cds', { p_cd_count: 1, p_size_mm: 3 }),
    ],
  },
  {
    file: '0070_store_manager_restructure_functions',
    probes: [
      () => rpc('inventory_list', { p_item_type: 'thread' }),
      () => rpc('sm_po_list'),
      () => rpc('procurement_users'),
      () => rpc('material_request_history'),
      // Deliberately invalid: an unknown type is refused during validation, so
      // the probe proves existence without writing anything.
      () => rpc('sm_add_inventory', { p_item_type: 'PROBE', p_color_code: 'PROBE' }),
    ],
  },
  {
    file: '0071_shortfall_split_issue_and_handover',
    probes: [
      () => rpc('fm_handover_queue'),
      () => rpc('fm_handover_lines', { p_order_id: NIL }),
      () => rpc('fm_submit_handover', { p_order_id: NIL, p_items: [] }),
    ],
    note: "submit_order, sm_issue_materials and fm_accept_inventory are also rewritten here at their EXISTING signatures, so no probe can tell 0071's versions from the older ones. `npm run verify:store` is what proves the shortfall split and the mounting are live.",
  },
  {
    file: '0072_daily_audit',
    probes: [
      () => rpc('audit_today_state'),
      () => rpc('audit_walk_items'),
      () => rpc('audit_history', { p_limit: 1 }),
      () => rpc('audit_detail', { p_audit_id: NIL }),
      () => col('stock_audits', 'audit_type'),
      () => col('stock_audit_items', 'marked_correct'),
    ],
  },
  {
    file: '0074_fix_reorder_levels_after_rename',
    probes: [() => rpc('sm_set_reorder_levels', { p_color_code: 'PROBE-COLOR', p_reorder_threshold: -1 })],
    note: "same signature as 0046, so this probe only proves the function exists — both the broken upsert and the fix answer it identically, because a negative threshold is refused before either reaches the write. `npm run verify:store` section 1 makes a REAL call, which is what tells them apart (the pre-0074 version returns 42P10).",
  },
  {
    file: '0075_handover_requires_finished_order',
    probes: [() => rpc('fm_handover_queue')],
    note: "0075 only changes the BODY of fm_submit_handover and fm_handover_queue at 0071's signatures, so nothing on the REST surface distinguishes them. `npm run verify:store` section 6 proves the guard by calling the RPC against an order that is NOT finished and requiring a refusal.",
  },
  {
    file: '0073_fix_grn_queue_join',
    probes: [() => rpc('my_queue_items', { p_queue_key: 'grn_pending' })],
    note: "same signature as 0066/0067 — only the grns join changed, so this probe cannot tell the fixed version from the broken one. It CAN be told apart by data: with at least one pending GRN, the broken version raises 42703 and the fixed one returns rows. `npm run verify:store` section 8 does exactly that.",
  },
];

/** Policy-only or repair migrations that leave no fingerprint a client can read. */
const UNDETECTABLE = [
  ['0003b_seed_profiles_by_email', 'alternative to 0003; same end state'],
  ['0004_fix_auth_user_null_tokens', 'repairs auth token columns — invisible unless logins fail'],
  ['0006_masters_factory_id_default', 'a column DEFAULT'],
  ['0076_audit_type_default_weekly', "a column DEFAULT (stock_audits.audit_type), which REST never reports. Its effect shows in `npm run verify:tenancy` section 31: without it the legacy weekly sm_submit_audit writes rows labelled 'daily', collides with uq_daily_audit_per_day, and the RED-01 ledger trail stops reconstructing."],
  ['0010_order_photos_storage', 'storage bucket + policies (not on the REST surface)'],
  ['0011_not_found_status', 'changes an error code, not the schema'],
  ['0014_backfill_opening_movements', 'a data backfill'],
  ['0015_storage_allow_procurement', 'a storage policy'],
  ['0021_finishing_seed', 'dev seed data; follows 0019/0020'],
  ['0026_fix_order_status_constraint', 'a CHECK constraint (0019 sets the same one)'],
  ['0027_cap_loan_installment', 'replaces a function 0030 also replaces'],
  ['0033_manager_type_on_add_employee', 'widens create_employee\'s role allow-list; same signature as 0030, no new fingerprint'],
  ['0047_fix_super_admin_orders_leak', 'a policy rewrite whose only visible effect is on a super_admin login, which this single-login script does not use — verify with `npm run verify:tenancy` (section 42) instead'],
  ['0055_returns_piece_index_total_order', "body-only rewrite of ot_return_repeats at 0054's signature — makes the returns board's piece numbering deterministic. `npm run walk:lifecycle` (section 7) proves it"],
];

(async () => {
  TOKEN = await login();
  if (!TOKEN) {
    console.error(`\nCould not sign in as ${EMAIL}. Set CHECK_EMAIL / CHECK_PASSWORD to override.\n`);
    process.exit(2);
  }

  console.log(`\n  Project: ${URL}`);
  console.log(`  Signed in as: ${EMAIL}\n`);

  const missing = [];
  for (const m of MIGRATIONS) {
    const results = await Promise.all(m.probes.map((p) => p()));
    const failed = results.filter((r) => !r.ok);
    const state = failed.length === 0 ? 'APPLIED' : failed.length === results.length ? 'MISSING' : 'PARTIAL';
    if (state !== 'APPLIED') missing.push(m.file);

    const mark = state === 'APPLIED' ? '  ok  ' : state === 'MISSING' ? ' MISS ' : ' PART ';
    console.log(`  [${mark}] ${m.file}`);
    for (const f of failed) console.log(`             ${f.why}`);
    if (state === 'PARTIAL') {
      console.log('             partially applied — re-run the whole file (they are idempotent)');
    }
    if (m.note && state !== 'APPLIED') console.log(`             note: ${m.note}`);
  }

  console.log('\n  Not detectable from the client (run them if in doubt — all are idempotent):');
  for (const [file, why] of UNDETECTABLE) console.log(`     ${file.padEnd(38)} ${why}`);

  if (missing.length) {
    console.log('\n  RUN THESE, IN THIS ORDER, in the Supabase SQL editor:\n');
    for (const f of missing) {
      console.log(`     supabase/migrations/${f}.sql`);
      // The Phase 6 seed has no fingerprint of its own, so it is suggested
      // alongside the functions it depends on rather than probed.
      if (f === '0020_finishing_functions') {
        console.log('     supabase/migrations/0021_finishing_seed.sql        (dev seed, optional)');
      }
    }
    // 0022 drops and recreates the `leaves` select policy WITHOUT the accountant
    // on it. If 0031 is already live, that silently revokes what the Employees
    // box reads, and the fix is simply to re-run 0031 afterwards.
    const applied = MIGRATIONS.filter((m) => !missing.includes(m.file)).map((m) => m.file);
    if (missing.includes('0022_phase8_dashboard_schema') && applied.includes('0031_accountant_dashboard')) {
      console.log('     supabase/migrations/0031_accountant_dashboard.sql  (re-run: 0022 resets the leaves policy)');
    }
    console.log(
      '\n  Paste each file whole — dollar-quoted function bodies and DO blocks\n' +
      '  break if you run them statement by statement. Re-running a file is safe;\n' +
      '  they are written to be idempotent.\n'
    );
  } else {
    console.log('\n  Every detectable migration is applied.\n');
  }

  process.exit(missing.length ? 1 : 0);
})();
