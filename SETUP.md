# Factory ERP — Setup (Phase 1: Foundation)

Multi-tenant SaaS mobile app for embroidery factories.
**Stack:** React Native (Expo) + Supabase (Postgres + Auth + Storage + RLS).

Phase 1 delivers the shell every later phase plugs into: tenancy tables with Row
Level Security, auth + session persistence, the role router (13 roles), and the
shared app shell. **No business screens yet.**

---

## 1. Create a Supabase project

1. Create a project at <https://supabase.com/dashboard>.
2. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.

## 2. Configure environment

Edit `.env` in the project root (already gitignored) and paste your values:

```
EXPO_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

## 3. Run the database migrations

In the Supabase dashboard → **SQL Editor**, run these files **in order** (contents
are in `supabase/migrations/`):

| Order | File | What it does |
|------|------|--------------|
| 1 | `0001_foundation_schema.sql` | Tables + RLS helper functions + **RLS policies** |
| 2 | `0002_seed_reference.sql` | Roles, 4 modules, 2 dummy factories (Alpha/Beta) |
| 3 | `0003_seed_dev_users.sql` | **Dev only** — creates all test logins + profiles |
| 4 | `0004_fix_auth_user_null_tokens.sql` | Repairs NULL auth token columns (see note) |
| 5 | `0005_masters_schema.sql` | **Phase 2** — vendors, suppliers, machines, finishing partners + RLS |
| 6 | `0006_masters_factory_id_default.sql` | Defaults `factory_id` to the caller's own factory |
| 7 | `0007_order_spine_schema.sql` | **Phase 3** — orders, order_stages, sheets, repeats, repeat_stage_history, job cards, damage + RLS |
| 8 | `0008_order_spine_functions.sql` | Transition RPCs (all history-first) + `order_timeline()` |
| 9 | `0009_seed_thread_stock.sql` | Dev seed: opening thread stock (uneven, so both inventory branches are testable) |
| 10 | `0010_order_photos_storage.sql` | `order-photos` bucket + factory-scoped storage policies |
| 11 | `0011_not_found_status.sql` | Makes "not found" return 404 instead of 500 |
| 12 | `0012_inventory_schema.sql` | **Phase 4** — GRNs, material issues, audits, `stock_movements` ledger + RLS |
| 13 | `0013_inventory_functions.sql` | PO execution + store RPCs, all routed through `log_stock_movement` |
| 14 | `0014_backfill_opening_movements.sql` | Reconciles the seeded stock with the ledger |
| 15 | `0015_storage_allow_procurement.sql` | Lets procurement upload supplier bills |
| 16 | `0016_shift_payroll_schema.sql` | **Phase 5** — shifts, downtime, bonus slabs, worker_ledger + RLS |
| 17 | `0017_shift_payroll_functions.sql` | Shift open/close/idle RPCs + accountant payroll RPCs |
| 18 | `0018_shift_payroll_seed.sql` | Alpha machines, worker stitch rates, bonus slabs + storage policy |
| 19 | `0019_finishing_schema.sql` | **Phase 6** — finishing handoffs, returns, SLA, collection QA |
| 20 | `0020_finishing_functions.sql` | Handoff / return / collection-QA / delivery RPCs |
| 21 | `0021_finishing_seed.sql` | Phase 6 dev seed |
| 23 | `0023_finance_schema.sql` | **Phase 7** — invoices, payments, expenses, loans, partner_ledger, user_permissions |
| 24 | `0024_finance_functions.sql` | Invoicing, payments, approvals, salary-run loan logic |
| 25 | `0025_report_functions.sql` | The five reports (pure aggregates) |
| 26 | `0026_fix_order_status_constraint.sql` | Fixes a Phase 6 latent bug (see Phase 7 notes) |
| 27 | `0027_cap_loan_installment.sql` | Never deduct more than a worker earned |
| 28 | `0028_super_admin_billing_inventory.sql` | Super admin: billing fields, **revokes** its blanket business-data read, grants read-only inventory, `sa_*` RPCs, login gate for inactive factories |
| 29 | `0029_partner_earning_posting.sql` | `post_partner_earning` — realized on collection-QA pass, once per repeat + stage |
| 30 | `0030_company_admin_masters_employees.sql` | Master rate/type/partner fields + live stat panels; `manager`/`labour` roles; `employee_compensation` + `create_employee`/`deactivate_employee`; salary run branches by pay type |
| 31 | `0031_accountant_dashboard.sql` | Accountant's six boxes: `invoices.photo_url`/`due_date`, `expenses.bill_subtype` + `bills` category, `leaves` (accountant-readable), **photo mandatory in every money-posting RPC**, and the `acct_*` read aggregates |
| 32 | `0032_order_taker_returns.sql` | Order Taker's Returns board — two read-only aggregates (`ot_return_repeats`, `ot_handover_orders`) over Phase 6 stage data. No new tables, no new state |
| 33 | `0033_manager_type_on_add_employee.sql` | `create_employee` accepts `floor_manager`/`store_manager` — the Add Employee "Manager" picker now asks which, since plain `manager` has no navigator of its own |
| 34 | `0034_qa_repeat_qa.sql` | Piece-by-piece Repeat QA (`qa_pass_piece`/`qa_reject_piece`/`qa_complete_repeat_qa`) |
| 35 | `0035_floor_manager_dashboard.sql` | Floor Manager dashboard boxes incl. `fm_accept_inventory` |
| 36 | `0036_order_taker_complete_return.sql` | Order Taker's "Complete return" — `repeats.ot_return_confirmed_at` + `ot_complete_return`, does not touch `current_status` |
| 37 | `0037_fm_job_card_line_edit.sql` | Editable needle/colour mapping (`fm_update_job_card_line`, locked once confirmed) + 6-needle cap enforced (hard-fail) in `fm_generate_job_card` |
| 38 | `0038_fm_vendor_informed.sql` | `job_cards.vendor_informed_at` + `fm_mark_vendor_informed` — idempotent, independent of the share/confirm status flip |
| 39 | `0039_fm_ask_for_material.sql` | `job_cards.material_requested_at` + `fm_ask_for_material` — **behavior change**: `material_issue_queue()` now requires this flag, not just `status='confirmed'`, so nothing reaches the Store Manager until the Floor Manager explicitly asks |
| 40 | `0040_fm_accept_inventory_photo.sql` | `material_issues.accepted_photo_url` + `fm_accept_inventory` now requires a photo (signature change: drops the old 1-arg overload) |
| 41 | `0041_machine_selection_pending.sql` | New order status `machine_selection_pending` (inserted after `job_card_confirmed`) + `orders.assigned_machine_id`; `fm_accept_inventory` now also flips the order into this status; `fm_assign_machine` (requires the machine to have an open shift, does not itself advance status further) + `fm_shifts_for_date` (Shift Calendar) |
| 42 | `0042_shift_worker_photo_and_start_time.sql` | `shifts.worker_photo_url` (required) + `shifts.reported_start_time` (display-only — `opened_at` stays the real insert time, since `0025`'s machine-hours report depends on it); `fm_open_shift` signature change (drops the old 5-arg overload) |
| 43 | `0043_stage_tracking_schema.sql` | Schema foundation for the Repeats & Stage Tracking loop (Stage 9) — `repeats.current_stage_index` + `repeats_current_status_check` extended with `awaiting_stage`/`in_progress`/`stage_qa`. Landed ahead of 0044 since that RPC writes into these statuses. A new, independent pipeline — not layered onto the Phase 6 handoff/collection-QA mechanism (see the migration's header for why) |
| 44 | `0044_fm_start_production.sql` | `fm_start_production` — requires a machine assigned (0041) with an open shift (0042), flips the order to `in_production`, advances its repeats from `ready_for_production` to `awaiting_stage` at stage index 1 |
| 45 | `0045_stage_tracking_loop.sql` | `fm_start_stage`/`fm_send_to_stage_qa` (Floor Manager) + `qa_pass_stage_qa`/`mark_stage_damage` (**QA-only** in this loop) — the repeat cycles `awaiting_stage → in_progress → stage_qa → awaiting_stage` (next stage) or `→ awaiting_final_qa` on the last configured stage. `mark_stage_damage` mirrors `qa_collection_damage`'s (0020) pattern but fixes its hardcoded-null `responsible_id` by resolving the worker from the repeat's assigned-machine's open shift |
| 46 | `0046_low_stock_auto_po.sql` | `thread_stock.reorder_threshold`/`reorder_quantity` + `sm_set_reorder_levels`; `log_stock_movement` (0013) extended to auto-raise a `purchase_orders` row (deduped against an already-open auto PO for that colour) whenever a movement drops a colour below its threshold — fully automatic, no manual trigger anywhere, fires from a GRN/issue/audit/any other movement, not just order-submission time |
| 47 | `0047_fix_super_admin_orders_leak.sql` | **Security fix**, unrelated to Stages 1-10: `orders_select` (0007) still had `or is_super_admin()` even after 0028's revoke — 0028 wraps whatever policy is *live* when it runs, so a later recreation of `orders_select` (e.g. 0007 re-pasted) silently brings the bypass back. Redefined directly with no super_admin clause at all, so there's nothing left to reintroduce. `orders_insert`/`orders_update_draft`/`orders_delete_draft` were audited too — none reference `is_super_admin()`, write access was already correctly zero |

> `0022_phase8_dashboard_schema.sql` is a **Phase 8** file and is intentionally
> not applied yet. Its `loans` / `partner_ledger` definitions use
> `create table if not exists` and are column-compatible with `0023`, so whichever
> runs first wins and the other no-ops.

`_combined_run_all.sql` bundles 1–3 for a single paste-and-run.

### Which migrations are actually applied?

```bash
npm run check:migrations
```

Signs in with the anon key as a seeded user and probes the live project for each
migration's tables, columns and functions, then prints the ones to run and in
what order. Read-only — every RPC probe passes deliberately invalid arguments so
the function refuses during validation and writes nothing. It exits non-zero when
something is missing, so npm prints an error block; that is the point.

Reach for it whenever a screen shows *"column X does not exist"* or *"Could not
find the function … in the schema cache"*. Both mean the same thing: the file is
in `supabase/migrations/` but was never pasted into the SQL editor.

Two traps it exists to avoid, both of which cost real debugging time:

- **A function with required arguments cannot be probed with no arguments.**
  PostgREST resolves overloads by parameter name, so a bare call to a two-argument
  function returns "not found" and is indistinguishable from a missing function.
- **A function whose body references a missing column still exists.** plpgsql
  plans its SQL at run time, so 0031's functions installed perfectly while the
  columns 0030 was supposed to add were absent — the screens then failed with
  *column does not exist* rather than *function not found*, pointing at the wrong
  migration.

A handful of migrations leave no fingerprint a client can read (policy-only,
seeds, error-code changes, column defaults). Those are listed separately in the
output rather than guessed at.

> If step 3 errors on your project's auth schema, instead create the users by hand
> in **Authentication → Users** (emails below), then run
> `0003b_seed_profiles_by_email.sql` to attach their profiles.

### Gotcha: "Database error querying schema" on login (500)

When you insert directly into `auth.users`, the token columns
(`confirmation_token`, `recovery_token`, `email_change_token_new`, …) default to
`NULL`. GoTrue scans them into non-nullable Go strings, so **every login fails
with a 500** — even though the row looks fine. They must be `''`.

`0003` now sets them explicitly, and `0004` backfills any already-seeded rows.
If you ever hand-insert auth users, remember this.

### Gotcha: direct DB connection is IPv6-only

`db.<ref>.supabase.co` resolves to IPv6 only. On an IPv4-only network it fails
with `ENOTFOUND`/`ENETUNREACH`. Use the **Session pooler** connection string
(`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`) for any CLI or
script access. Port 5432 (session), not 6543 — the transaction pooler chokes on
multi-statement DDL and `DO $$` blocks.

## 4. Run the app

```bash
npx expo start -c        # -c clears cache so the new .env is picked up
```

Then press `w` for web, `a` for Android, or scan the QR with Expo Go.

---

## Test logins (from the dev seed)

All passwords: **`Password123!`**

| Login | Role | Factory |
|-------|------|---------|
| `super@erp.test` | Super Admin | (platform, all factories) |
| `owner@alpha.test` | Owner | Alpha Embroidery Works |
| `floor@alpha.test` | Floor Manager | Alpha |
| `worker@alpha.test` | Worker | Alpha |
| `owner@beta.test` | Owner | Beta Stitch House |
| `floor@beta.test` | Floor Manager | Beta |
| … | one per role, in both factories | Alpha / Beta |

Full set: `<role>@alpha.test` / `<role>@beta.test` where role ∈
`owner, accountant, floor, store, order, qa, procurement, delivery, worker, partner`.
`manager` and `labour` have no seeded logins — they are created at runtime via the
Owner's Add Employee flow (`create_employee`, migration 0030).

**Module gating test data:** Alpha has all 4 modules enabled; Beta has only Order
Lifecycle + Inventory (Machine & Workforce and Finance are **disabled**) — use this
to test module gating across tenants in later phases.

---

## Phase 1 — Definition of Done — ✅ VERIFIED (2026-07-30)

Verified against the live Supabase project; **41/41 automated checks passed**
plus a manual end-to-end pass in the running app.

- [x] **Login works** as a seeded user from either factory — all 21 logins
      authenticate and resolve the correct role + `factory_id`.
- [x] **Role routing:** verified `floor@alpha.test` → "Today's Floor" and
      `worker@beta.test` → "My Dashboard", header showing correct factory + badge.
- [x] **Session persistence:** reloaded the app while logged in → still logged in.
- [x] **Logout** clears the session and returns to Login.
- [x] **Tenant isolation (the critical one):** Alpha cannot read *or write* any of
      Beta's `factories` / `profiles` / `factory_modules` rows, and vice versa;
      a cross-tenant `UPDATE` affects 0 rows. Anonymous access returns `[]` on
      every table. Super admin sees both factories (tenancy only).
- [x] **Module gating:** `module_enabled()` returns `true` for Alpha and `false`
      for Beta on `machine_workforce`; the UI reflects Alpha=4, Beta=2 modules.

To re-run the automated suite yourself, the script lives outside the repo
(scratchpad); the manual checks below are the durable version.

### Verifying tenant isolation directly (not just through the UI)

RLS is the real guard. To prove it, query as an authenticated user via the REST API
with their access token (get one by signing in), then try to read the *other*
factory's row:

```bash
# As an Alpha user, ask for Beta's factory id — RLS must return an empty array.
curl "$EXPO_PUBLIC_SUPABASE_URL/rest/v1/factories?id=eq.22222222-2222-2222-2222-222222222222" \
  -H "apikey: $EXPO_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer <ALPHA_USER_ACCESS_TOKEN>"
# Expected: []   (not Beta's row)
```

The same must hold for `factory_modules` and `profiles`. Super admin is the only
role that can read across factories, and only for tenancy tables.

---

## Phase 2 — Masters — ✅ VERIFIED (2026-07-30)

Four master entities (vendors, suppliers, machines, finishing partners) built on
**one** generic config-driven list/form pair. **97/97 automated checks pass**
(`npm run verify:tenancy`) plus a manual end-to-end pass in the app.

### Design decision: masters are archived, not deleted

The brief asked whether soft-delete was preferable. It is, and it's what's built.
Master records are reference data that Phase 3+ links to (orders → vendors, job
cards → machines, partner ledger → partners). Hard-deleting a vendor with
historical orders either fails on a foreign key or destroys the audit trail.

So `deleted_at` archives instead: the row leaves lists and pickers, existing
references keep resolving, and an owner can restore it. Orphaning is
structurally impossible. Hard `DELETE` still exists for genuine mistakes and is
owner-only; where a row is referenced, the FK refuses it (HTTP 409) and the UI
shows "…is referenced by other records, so it can't be removed. Archive it
instead."

### Who can do what (mirrored in RLS *and* the entity configs)

| Entity | Read | Create / Edit | Archive | Module gate |
|---|---|---|---|---|
| Vendors | any role in factory | owner, order_taker | owner | — (core) |
| Suppliers | any role in factory | owner, procurement, accountant | owner | — (core) |
| Machines | any role in factory | owner, floor_manager | owner | Machine & Workforce |
| Finishing Partners | any role in factory | owner, accountant | owner | Order Lifecycle |

Super admin can read across factories for support but **cannot write** business
data (spec §2). Because Beta has Machine & Workforce disabled, its floor manager
gets no Machines screen at all — and the DB rejects the query even if the UI were
bypassed.

### Adding a fifth master entity later

Add a config object to `src/masters/configs.ts`, list it in
`src/navigation/roles/roleMasters.ts`, and write its table + policies. No new
screens.

### What was verified

- Create, search (case-insensitive partial), edit, archive, restore — for each
  entity, from each role that owns it.
- Required-field validation fires client-side; DB errors are mapped to plain
  language (duplicate name, FK conflict, RLS refusal) — never a raw Postgres string.
- **Cross-tenant:** Beta cannot read, list, update or delete any of Alpha's rows
  on all four tables; forging `factory_id` on insert is rejected (403); Alpha's
  data verified intact after every attempt.
- **Per-role writes:** order_taker can create vendors but not suppliers;
  procurement the reverse; floor_manager machines only; worker and QA nothing.
- **Module gating in RLS:** Beta floor manager cannot read *or* write machines.
- Names unique per factory; the same name is allowed in a different factory.
- Anonymous reads and writes blocked on all four tables.

## Phase 3 — Order Spine — ✅ VERIFIED (2026-07-30)

The demoable milestone: a vendor order broken into sheets, then into individually
coded repeats, carried through to a vendor-confirmed job card.
**151/151 automated checks pass** plus a full manual run through the app.

### The rule that governs this phase

`repeat_stage_history` is the **single source of truth** for where a repeat is.
`repeats.current_status` is a **denormalized cache**.

Every transition goes through `log_repeat_stage()`, which appends the history row
and refreshes the cache *in the same transaction*, so they cannot drift. There is
no RLS policy permitting a direct insert into `repeat_stage_history` or a direct
update of `current_status` — both are refused (verified), so a screen physically
cannot "just flip the status" and leave later phases with nothing to query.

Read history when you need provenance (who moved it, when, with what photo).
Read `current_status` only to filter a list.

### Flow

| Role | Screens |
|---|---|
| Order Taker | My Orders → 5-step capture (vendor → cloth photos → sheet builder → design sheet → review) → read-only Order Detail |
| QA | Inspection Queue → Cloth Inspection (accept / damage w/ reason) → Repeat Coding |
| Floor Manager | Second-QA Queue → Stage Sequence → Job Card → Share → Confirm |

**Repeat codes:** `<FACTORY>-<ORDER#>-S<sheet>-R<repeat>`, e.g. `ALP-00010-S1-R001`.
Globally unique — the prefix embeds the factory.

**Thread check on submit:** requirement per colour = `stitches × repeats ×
0.0045 m`, split across the sheet's colours, compared to `thread_stock`. Sufficient
→ *Awaiting Cloth Inspection*; short → *Awaiting Procurement* + an auto-generated
PO. The metres-per-stitch constant lives only in
`order_thread_requirements()` so Phase 4 can make it a per-factory setting.

### Two deliberate deviations from the v1 ERD

1. **`damage_records.repeat_id` is nullable, and `order_id`/`sheet_id` were
   added.** The ERD hangs damage off repeats only, but incoming cloth inspection
   happens *before* repeat coding — there is no repeat to reference yet. Vendor
   damage attaches to the order; worker (Phase 5) and partner (Phase 6) damage
   attaches to a repeat, enforced by a CHECK constraint.
2. **`sheets` carries `repeats_count`, `thread_color_codes`, `stitch_count`.**
   The brief lists only `color_assignment`, but the sheet builder captures these
   and `repeats_count` is precisely what repeat coding expands.

### What was verified

- A full order with multiple sheets, each with its own colours / repeat counts /
  stitch counts, captured and submitted through the wizard.
- Both inventory branches: stocked colours → inspection; unstocked → procurement
  with an auto-PO naming the short colour.
- QA damage (vendor-accountable, `repeat_id` null) then acceptance.
- Coding created **one `repeats` row per repeat** — 6 + 4 sheets → 10 rows with
  distinct codes, count verified against what was entered at capture. Re-running
  coding is idempotent.
- **20 history rows for 10 repeats** (`coded` ×10, `ready_for_production` ×10),
  every row carrying an actor; `coded` has no stage (pre-sequence),
  `ready_for_production` points at stage 1. **Zero cache/history drift.**
- Job card lines = one needle per distinct thread colour, stitch totals correct.
- Full vendor loop: share → changes requested (back to draft, order returns to the
  FM queue) → re-share → Confirmed. Confirming before sharing is refused.
- Order Taker read-only after submit, enforced three ways: no UI control, the RLS
  update policy matches `status='draft'` only, and the QA/FM RPCs refuse their
  role (403).
- Timeline derived, not hardcoded: it grew exactly the three configured stages,
  and a shortfall order's timeline shows a procurement step and no stages.
- Cross-tenant: Beta cannot read Alpha's orders, sheets, stages, job cards, damage
  or POs; queue counts exclude the other tenant; cross-tenant RPC calls return
  404 (same response as "doesn't exist", so ids can't be probed).

### Test data

`npm run verify:tenancy` leaves its submitted orders behind on purpose — they are
not API-deletable, and weakening that rule to tidy up after a test would be the
wrong trade. Clear them with:

```bash
psql "$POOLER_URL" -f supabase/maintenance/cleanup_test_data.sql
```

## Phase 4 — Inventory & Procurement — ✅ VERIFIED (2026-07-30)

Store Manager (thread stock) and Procurement (purchase orders).
**205/205 automated checks pass** plus a manual run through the app.

### The rule that governs this phase

`stock_movements` is the **unified ledger**. Every change to `thread_stock` of any
kind goes through `log_stock_movement()`, which updates the balance and appends
the ledger row *in the same transaction*. There is no RLS policy permitting a
direct write to either table — both are refused (verified) — so stock cannot move
without a movement behind it. Phase 7's leakage report has nothing else to read
from, and a movement missed now could not be backfilled.

**Quantities are signed** (+ receipt, − issue, ± audit). A running sum of a
colour's movements therefore equals its balance exactly; `balance_after` is stored
per row so the walk can be checked step by step. Verified: **0 colours** where the
ledger disagrees with the balance.

### Two deliberate deviations from the brief

1. **There is an `opening` movement type**, not just `grn|issue|audit_variance`.
   The opening balance has to be in the ledger or the running sum starts from
   nothing and can never reconcile. Recording it as a `grn` would be worse — it
   would appear as a supplier receipt in the leakage report.
2. **Manual PO creation was added.** You were asked and didn't answer, so I built
   it: auto-generation only fires on an order-driven shortfall, so without it a
   factory could never restock buffer thread, replace a damaged cone, or buy ahead
   of season. Say the word and it comes out — it's one screen plus one RPC.

### Approval and payment are RPCs, not screens

`po_owner_approve()` and `po_record_payment()` exist so a PO can actually reach
handover; without them the whole procurement walk would be untestable until
Phase 7. The **screens** remain out of scope as specified — the Approvals Inbox
and Ledgers Home are Phase 7 and will wire UI to these same functions rather than
reimplementing the transitions. Procurement sees those two steps as read-only
wait states.

### Opening stock runs once

Gated on `factories.opening_stock_completed_at`, **not** on "is `thread_stock`
empty" — emptiness is unsafe, because a factory could delete rows years in and
silently re-open the entry over real counts. The DB refuses a second run whatever
the UI does; the UI additionally hides the entry point once done, and points at
the weekly audit for corrections.

### What was verified

- Full PO walk: execute → bill → awaiting owner approval → awaiting accountant
  payment → handover → GRN. Out-of-order steps refused; a second handover refused.
- Wrong roles refused at every gate (procurement cannot approve or pay its own PO).
- Handover alone does **not** move stock — only the store manager's confirmation
  does, because until then nobody has counted it.
- GRN confirm: RED-01 rose by exactly the received amount; a short delivery
  (1,500 of 2,000) credited only what arrived; non-thread lines correctly skipped;
  `grn` movements all positive; PO closed out as `received`.
- Material issue: stock fell by exactly the requirement, `issue` movements all
  negative, the movement → material_issue → job card chain intact, a second issue
  for the same job card refused, and stock cannot be driven negative.
- Audit with a deliberate mismatch: stock set to the counted figure, variance
  stored as a signed delta, `audit_variance` movement logged.
- **Full trail for one colour** (`RED-01`): `opening → grn → issue →
  audit_variance`, every row carrying type, quantity, actor, timestamp and the
  document that caused it; running sum === balance; `balance_after` agrees at
  every step.
- Cross-tenant: Beta sees none of Alpha's stock, movements, GRNs, issues, audits
  or POs; cross-tenant RPCs return 404; Beta's ledger references no Alpha document.

## Phase 5 — Shift Close + Payroll — (pending verification)

Machine assignment, camera-only panel capture, stitch-count payroll posting, and
accountant salary runs. Floor managers walk machines one at a time; the close photo
**is** the payroll record.

### The rule that governs this phase

`worker_ledger` is the **payroll ledger**. Every stitch payout from a shift close
goes through `fm_close_shift()`, which closes the shift and appends the ledger row
*in the same transaction*. `flagged_idle` shifts are excluded — no ledger posting.
There is no RLS policy permitting a direct write to `shifts` or `worker_ledger`.

Stitch delta = `confirmed_stitches − open_stitches`. Bonus slabs are evaluated
incrementally against the worker's daily total at posting time.

### Flow

| Role | Screens |
|---|---|
| Floor Manager | Today's Floor → Machine assignment / Shift close walk → multi-step close (camera → upload → detect → confirm → downtime → post) |
| Owner | Bonus slabs + read-only access to assignment/close queues and salary run |
| Accountant | Salary run → per-worker ledger detail → finalize period |

**Panel photos:** camera-only via `expo-camera` (`PanelCamera`) — never the gallery-capable `PhotoPicker`. Upload path: `{factoryId}/shifts/{shiftId}/{open\|close}-{ts}.jpg` in the private `order-photos` bucket.

**Module gate:** `machine_workforce` — Alpha enabled, Beta disabled (same tenancy test pattern as masters).

### What to verify

- FM lists only machines they manage; open shift assigns worker + optional order.
- Shift close walk lists open shifts; close posts pending ledger with correct stitch delta.
- Manager must confirm stitch count (vision detection is advisory only).
- Flag idle closes shift without ledger row.
- Accountant sees salary run summary, worker ledger detail, can finalize pending entries.
- Owner can CRUD bonus slabs via RPC.
- Cross-tenant: Beta cannot read/write Alpha shifts or ledger; Beta FM blocked when module off.
- Direct client writes to `shifts` / `worker_ledger` refused.

Run `npm run verify:tenancy` after applying migrations 0016–0018.


## Phase 7 — Finance Posting & Reports — VERIFIED (2026-07-31)

Closes the loops earlier phases left open. **67/67 automated checks pass.**

### What this phase resolves

| Left open by | Resolved here |
|---|---|
| Phase 6 deferred invoicing | Final QA -> `fm_generate_invoice` -> appears in Receivables |
| Phase 4 "awaiting owner approval" | Owner's Approvals Inbox |
| Phase 4 "awaiting accountant payment" | Accountant's Payables -> `acct_record_payment` |
| Phase 5 promised damage deductions | `owner_approve_damage` writes `worker_ledger.damage_deduction` |
| Phase 5 loans | `acct_add_loan` + salary run applies installments |

### Two latent bugs found and fixed

1. **`orders.status` CHECK was still the Phase 3 set.** Phase 6 added
   `in_production` / `in_finishing` / `awaiting_final_qa` / `ready_for_delivery` /
   `completed` to the TypeScript union but never to the constraint, so order-level
   progression past `job_card_confirmed` had always failed silently. Fixed in
   `0026`. (Repeat-level progression was unaffected — it has its own constraint.)
2. **Loan installments could drive net pay negative.** A worker with two active
   loans in a low-earnings period ended at `net = -2000`. Installments are now
   capped at what was actually earned; the remainder stays on the loan for a
   later period. Fixed in `0027`, with the affected row repaired.

### Answering the brief's verification request

> "The permission-check utility from Phase 1 should already be structured to
> check both base role and any granted add-ons — verify that's actually the case"

**It was not.** `canAccessRole()` only checked base role and `AuthContext` loaded
no grants. Phase 7 added `canAccess()` / `hasPermission()`, an enumerated
`PERMISSION_KEYS` set, and `permissions` on the auth context — *before* building
the Extra Permissions screen that depends on them.

### Design notes

- **Partner payment is one RPC, never three client calls.** `acct_pay_partner`
  writes `payments` + `expenses(partner_payment)` + `partner_ledger` in one
  transaction, because the P&L, the payables view and the partner dashboard each
  read a different one and all three must agree.
- **Loans are non-retroactive by construction**: `starts_period` is set to the
  month *after* the loan is recorded, so a run for a closed period cannot see it.
- **Damage deductions land only in an OPEN period** — `open_ledger_row()` refuses
  a finalized one, so a late approval never reaches back into pay already run.
- **Reports own no tables.** All five are pure aggregates; a wrong number gets
  fixed in the transaction that wrote it, not in a reporting table that can drift.

### Hand-checked profitability

Per the DoD, one order's figures were checked against raw transactions rather
than trusted: revenue against its invoice row, thread against its
`stock_movements` issue metres x the average purchase cost, labour against
`worker_ledger` on that order's shifts, finishing against `partner_ledger` on its
stages, and the arithmetic tied end to end. Note that labour and finishing were
legitimately **0** for the sampled order (no shifts or partner earnings attached
to it), so those two components confirm the query wiring rather than exercising
non-zero values; revenue and thread were non-zero and matched exactly.

## Phase 8 — Super Admin + Company Admin — (pending verification)

Super admin stops being able to read business data (0028), finishing partners
finally get paid (0029), and the Owner gets a Masters section plus staff
management (0030).

### 0028 — Super admin is a platform operator, not a data reader

The brief assumed super admin has no access to business data; it did not. Every
SELECT policy written through Phase 7 ended with `or public.is_super_admin()`, so
super admin could read orders, invoices, payments, everything. 0028 rewrites each
such policy as `(original) and not is_super_admin()` — so a normal user's access
is bit-for-bit unchanged and super admin's collapses to nothing — then grants it
back on exactly two tables, `thread_stock` and `stock_movements`, **read-only**.
Tenancy + billing management lives in `sa_*` SECURITY DEFINER RPCs
(`sa_factory_list`, `sa_factory_modules`, `sa_toggle_module`, `sa_create_factory`,
`sa_update_factory`, `sa_set_account_status`, `sa_factory_inventory`,
`sa_last_audit`, `my_factory_active`). The login gate now signs a user straight
back out if their factory `account_status` is `inactive`.

### 0029 — Partner earnings are realized, not imagined

Phase 6 recorded handoffs and returns but never posted the partner's earning, so
the Phase 8 partner dashboard and report finishing-cost both read
`partner_ledger` `'earning'` rows that nothing produced — a permanent zero.
`post_partner_earning` now posts `rate x quantity` (per_stitch on the sheet's
stitch count, flat per repeat) once per repeat + stage when the returned stage
passes collection QA (`qa_collection_pass`). Rework through the same stage does
not pay twice.

### 0030 — Company Admin: Masters tabs + Employees

- **Masters columns:** vendors `rate_per_repeat` / `rate_per_stitch` / `price`;
  suppliers `address` / `payment_day` (1–31); machines `machine_type` (11-way
  CHECK); finishing partners `is_extended_partner`. Live stat panels
  `master_client_stats` / `master_supplier_stats` / `master_machine_stats` /
  `master_partner_stats` read the transaction tables — orders/invoices/payments/
  POs/shifts/repeats/partner_ledger — never a copy.
- **Employees:** `manager` and `labour` join the roles table. `employee_compensation`
  records `salary_type` (`per_month` / `per_day` / `per_stitch`) per staff member;
  RLS grants **read** to company_admin + accountant and **no direct writes**.
  `create_employee` (SECURITY DEFINER) makes the auth login + profile +
  compensation row in one transaction — the only way to create a login, since
  profiles writes are super-admin-only — and snapshots `profiles.stitch_rate` for
  piece-rate workers. `deactivate_employee` toggles `is_active` (history intact).
- **Salary run branches:** `acct_salary_run_summary` / `acct_finalize_salary_run`
  keep the per_stitch shift-close posting untouched, and add fixed rows
  (`shift_id IS NULL` marks them) for per_day = daily rate × days worked and
  per_month = flat salary. 0027's loan-capping logic is preserved.

### What to verify

`scripts/verify-tenancy.mjs` sections 42–49 cover this phase: super admin's read
revocation vs its two read-only grants, billing via `sa_factory_list` and the
`sa_*` refusal for non-super-admins, the new master columns + CHECK constraints,
manager/labour in the roles table, `employee_compensation` read scope and its
write refusal, the `create_employee` end-to-end (login works immediately,
duplicate email and short password refused, wrong roles refused, Beta's call
lands in Beta), stat panels matching each tenant's own row counts, the
per_month salary-run posting (once, shift_id null, no re-finalize duplicate),
and `deactivate_employee` scoped to the caller's factory. Run
`npm run verify:tenancy` after applying migrations 0028–0030. The run's test
employees are real auth logins and are left deactivated (not API-deletable),
mirroring the existing "orders are kept" stance.

## Accountant Dashboard — 6 boxes + Invoices — (pending verification)

The accountant's landing screen is now six cards and nothing else: **Clients,
Suppliers, Finishing Partner, Employees, Machines, Invoices**. The Phase 7
Ledgers Home is still there — reachable from inside the Invoices box, for loans
and payment history.

### The rule that governs this phase

**No money is recorded anywhere in this app without a photo.** Invoices,
payments, expenses, bills and partner payments all refuse without one, and the
refusal lives in the posting RPC (`assert_proof_photo`), not in the form. That
matters because the rule had to be retrofitted onto screens built in Phase 7:
putting it in the DB means every existing screen inherited it the moment the
migration ran, and no future screen can opt out.

It is **not** a CHECK constraint. Even a `NOT VALID` check fires on UPDATE of
pre-existing rows, so marking a seeded photo-less invoice paid would have
started failing. History stays readable and updatable; only new records are held
to the rule.

### What each box reads (no new tables)

| Box | Source |
|---|---|
| Clients | `vendors` + `invoices`/`payments` (income, received, pending, next due) + `damage_records` where `responsible_type='vendor'` |
| Suppliers | `suppliers` + `purchase_orders`/`po_items` + `payments`; billing date from `payment_day` |
| Finishing Partner | **the Company Admin's own master list + detail screen**, reached from the accountant's navigator — not a second implementation |
| Employees | `profiles` + `employee_compensation` + `worker_ledger` + `leaves`, every role |
| Machines | `machines` + `shifts` |
| Invoices | receivable from `invoices`; payable from `partner_ledger`, `purchase_orders`, `expenses(bills)`, `expenses(maintenance)`, `worker_ledger` |

### Design notes

- **Bill types are free text, not an enum.** `expenses.bill_subtype` holds
  whatever the user typed; `acct_bill_subtypes()` offers prior values back so the
  second electricity bill reuses the first one's spelling instead of splitting
  the total across two near-identical types. Adding a bill type therefore needs
  no migration and no admin screen.
- **Machine hours count closed shifts only.** Accruing an open shift to `now()`
  would make the same screen show a different total on every load and reconcile
  against nothing. Open shifts are listed and counted separately.
- **Salary is a summary that links into Salary Run**, never a second place to
  finalize payroll from.
- **The read RPCs assert their own module and role.** `SECURITY DEFINER`
  bypasses RLS, so the policy's module gate has to be restated inside the
  function or it is simply gone. (0030's `master_*_stats` do not do this.)
- **Module gating is visible on Beta**, which has Finance and Machine & Workforce
  disabled: its accountant gets the standard "module disabled" message on the
  money and people boxes, and the DB refuses those RPCs regardless of the UI.

### Two pre-existing bugs found and fixed

1. **The Finishing Partner detail panel could not load.** `getPartnerStats`
   selected `damage_records.quantity_meters`, a column that never existed — so
   the whole "Details" panel errored out for the Company Admin. 0031 adds the
   column (default 0; damage capture can start recording a real figure).
2. **Every partner showed the factory's total partner damage.** `getPartnerStats`
   filtered on `responsible_type='partner'` but not on `responsible_id`, so two
   partners with one damage between them both reported it. Now scoped to the
   partner being viewed. (It also filtered `approval_status <> 'cancelled'`, a
   value that status can never hold; it now excludes `rejected`, as intended.)

Also worth knowing: `partner_ledger.damage_charge` rows are written **negative**
by `owner_approve_damage` (0024) while 0022's partner dashboard reads them as
positive. `acct_payable_partners` sums the magnitude and always subtracts, so it
is correct under either convention.

### What to verify

`scripts/verify-tenancy.mjs` section 50 covers the photo rule on all four
posting RPCs, the bill-type round trip (create a new type, see it suggested
back), factory scoping of the `acct_*` reads, Beta's module refusal, role
refusal for a worker, anonymous refusal, the Employees box spanning more than
one role, machine hours reconciled against raw shift rows, and receivable total
income against the raw invoice rows. Run `npm run verify:tenancy` after applying
0031, against **both** seeded factories.

Manual passes still needed per screen (Alpha = all modules, Beta = finance and
machine/workforce off): each of the six cards opens; a client's income summary
adds up by hand; a supplier's next billing date matches its payment day; the
Finishing Partner card lands on the same screen the Company Admin uses; and no
form anywhere — new or Phase 7 — will submit without a photo attached.

## Order Taker Dashboard — 2 boxes + New Order — (pending verification)

The Order Taker lands on a "+ New Order" button and exactly two cards: **Orders**
(the Phase 3 list, unchanged apart from the created date now appearing on each
row) and **Returns** (new, read-only).

### Returns is read-only three ways over

No mutating control is rendered; rows do not navigate anywhere; both RPCs are
pure SELECTs; and every transition behind the data — handoff, return, collection
QA, final delivery — is an RPC that asserts delivery/QA/floor-manager role, so an
order taker calling one is refused by the database.

### The third tab is order-level, deliberately

`Active task` and `Completed` are per repeat. **`Handover` is per order**, because
Phase 6 records final delivery on the order (`delivered_at`,
`delivery_photo_url`, `delivery_signature_url` via `dp_complete_delivery`) — there
is no per-repeat handover row to read. Fanning the order's timestamp out across
its repeats would have looked like per-repeat data without being any. The tab
carries each order's repeat counts so it still reconciles against the other two.

Bucket definitions live in `0032`, not in the screen:

| Tab | Meaning |
|---|---|
| Active task | Handed off at least once, not yet through its final stage: out at a partner, in transit, or back awaiting collection QA |
| Completed | Came back **and** passed collection QA for its last stage (`awaiting_final_qa` / `completed`) |
| Handover | Order ready for final delivery, or already delivered |

A repeat with no handoff in its history is on none of the tabs — it has not
entered the return cycle, and calling it "active" would overstate the data.
Scope is the orders the signed-in user created (`orders.created_by`);
company_admin sees the whole factory.

### New Order flow — verified, with three findings

The flow is unchanged in steps or order: **1 Vendor → 2 Cloth photos → 3 Sheets →
4 Design sheet → 5 Review → submit**, and submit still runs
`create_order` → photo upload → `submit_order`, which does the thread check and
branches to *Awaiting Cloth Inspection* or *Awaiting Procurement* with an
auto-raised PO. It is reachable from the new button. Three things did not match
the described reference:

1. **The design sheet was not camera-only** — it used the gallery-capable
   `PhotoPicker`. Aligned: `cameraOnly` now hides the gallery option (the web
   build keeps it, since expo-image-picker has no web camera launcher and the
   step would otherwise be uncompletable in a browser). This is a UI
   restriction; `PanelCamera` remains the payroll-grade camera-only path.
2. **There is no "colour count" step and no photo per colour.** Colours are added
   ad-hoc as sheets in step 3, and cloth photos are one multi-photo set in step
   2. Left alone — that is a change to the flow's steps, which the brief said not
   to make.
3. **The submit note says thread only**, because the check *is* thread only
   (`order_thread_requirements`). It was left accurate rather than widened to
   "thread/tillah/sequin", which the system does not check.

Review now shows the design sheet photo itself rather than just "Attached".

### The reported permission leak: not reproducible in the Order Taker's app

Audited at all three layers, and the interactive QA / job-card controls are not
reachable by this role:

- **Navigator** — `createRoleNavigator` registers `JobCard`, `SecondQAQueue`,
  `ClothInspection`, `RepeatCoding`, `CollectionQueue` and `CollectionDetail`
  only when `role` is floor_manager or QA. An order taker's stack has no route to
  any of them.
- **Screen** — `OrderDetailScreen`, the only order screen an order taker can
  reach, renders no mutating control at all. The string "Continue to job card"
  does not exist anywhere in `src/`; that button lives on the floor manager's
  `JobCardScreen`, which is a different screen on a different stack.
- **Database** — `qa_accept_cloth`, `qa_generate_repeats`,
  `qa_report_cloth_damage`, `fm_set_stage_sequence`, `fm_generate_job_card`,
  `fm_share_job_card` and `fm_confirm_job_card` all `assert_role` to QA /
  floor_manager / company_admin.

Section 24 of the verify suite now probes all seven RPCs with an order-taker
token. **If those controls really were visible in a live order-taker session, the
screen showing them was not `OrderDetailScreen`** — most likely the session was
signed in as floor manager or QA, or was a preview. Worth re-checking against
`order@alpha.test` directly; if it reproduces, the screenshot of the header and
the visible tab labels would pin down which screen it actually is.

### What to verify

`scripts/verify-tenancy.mjs` section 51 covers the returns board: rows scoped to
orders the caller created, buckets matching repeat status, handover rows carrying
a real delivery stamp, Beta seeing none of Alpha's repeats, QA refused, anonymous
refused. Run `npm run verify:tenancy` after applying 0032, against both seeded
factories, then walk the New Order flow end to end on each.

## Lifecycle dead ends — job card confirm, Start Production, next-step guidance — VERIFIED (2026-08-02)

### The bug class this phase closes

Three separate reports, one shape: the order reaches a state the database can
leave, but no visible control reaches it. Nothing errors — the user simply runs
out of buttons and testing stalls.

| Dead end | Cause | Fix |
|---|---|---|
| Job card stuck at `draft` | "Ask for material" needed `status='confirmed'`, only reachable via a vendor-confirmation loop that was never in the spec | 0050 folded confirm into "Client informed" |
| Same, for *existing* rows | Cards informed before 0050 kept `vendor_informed_at` set with status still `draft`; the UI disables that button once the stamp exists, so the confirm branch could never run again | **0052** backfills them |
| Machine assigned, then nothing | "Start Production" existed only as a row action in the Orders box, not in the assignment view the user was standing in | Button now renders in `AssignMachineModal` |

### 0052 — exactly one gate from draft to material

`fm_ask_for_material` previously checked **two** things: `vendor_informed_at is
not null` **and** `status = 'confirmed'`. The spec asks for one. The second check
silently stranded any card confirmed through the retired `fm_confirm_job_card`
path (status confirmed, stamp null), so 0052 drops it — `status='confirmed'` is
now the only condition, server-side and in the UI (`JobCardScreen` keys its
Material section on `isConfirmed`, not on the stamp).

The backfill in 0052 writes `repeat_stage_history` directly rather than calling
`log_repeat_stage()`. That helper is auth-scoped — it resolves
`current_factory_id()` from the JWT, and a migration runs without one, so every
call raised "Repeat not found." The backfill uses each repeat's own `factory_id`
instead; it never reads a session value.

`fm_share_job_card` / `fm_confirm_job_card` / `fm_request_job_card_changes`
remain installed but unreferenced by `src/` — left in place so any job card a
prior session already pushed through them stays readable.

### Start Production, in the same view

`AssignMachineModal` no longer calls `goBack()` on a successful assignment. It
swaps to a confirmation state showing the assigned machine, the guidance banner,
and a **Start Production** button. Pressing it runs `fm_start_production` and
then returns to the Orders box. The row action there is unchanged, so both
routes work.

Note the modal renders the banner **inline** (`NextStepBanner`), not through the
app-level toast: a native-stack modal draws above the toast layer, and the whole
point is that the message and the button arrive together.

### Next-step guidance

`src/components/ui/NextStepToast.tsx` — one provider mounted above the navigator
in `App.tsx`, one `NEXT_STEP` map holding every string, a `useNextStep()` hook to
raise it, and `NextStepBanner` for the inline case. Seven moments are wired:
job card created (fired on "Submit job card", the press that lands the user on
the screen holding the next action), client informed, ask for material,
inventory accepted, machine assigned, production started, and a repeat's last
stage passing QA. That last one only fires when `qa_pass_stage_qa` actually
returns `awaiting_final_qa` — mid-sequence passes need no guidance, since the
row's own action moves along with it.

### QA's permission boundary — confirmed as specified, not changed

The spec asked to confirm before altering. **Confirmed: it is QA-only and it
holds.** Checked with real logins against a repeat genuinely sitting at
`stage_qa`, not a nil id and not visual inspection:

```
floor@ → qa_pass_stage_qa   403  "Your role (floor_manager) is not permitted…"
floor@ → mark_stage_damage  403  same
qa@    → qa_pass_stage_qa   ok   advances the repeat
qa@    → mark_stage_damage  ok   damage recorded
qa@    → fm_start_stage     403  mirror boundary also holds
```

Floor Manager sees the same table because the read side has no role gate beyond
factory/module scoping (`StageTrackingTable` is shared deliberately) — only the
two QA actions are refused. Nothing was changed here.

### What was verified

`npm run walk:lifecycle` creates a real order and drives it through every role
with real logins on the anon key — the same surface the app has.

```
npm run walk:lifecycle alpha     42 passed, 0 failed   (ALP-00061, full loop)
npm run walk:lifecycle beta      22 passed, 0 failed   (BET-00023, see below)
```

Alpha walks the whole thing: create → submit → cloth inspection → piece-by-piece
repeat QA → stage sequence → job card → **draft blocks material** → Client
informed **confirms the card in one press** → material requested immediately
after → store manager issues → floor manager accepts with photo →
`machine_selection_pending` → assign machine → **order stays pending until Start
Production**, proving the button is a real required step → `in_production` → both
stages of the repeat loop with the QA boundary checked at each → last stage →
`awaiting_final_qa`.

Beta stops at machine assignment **by design** — Machine & Workforce is disabled
for that tenant, and the walk asserts the module gate refuses ("This feature is
not available for your factory") rather than skipping the check. Everything up to
that point, including both job-card fixes, passes identically. Beta ships with no
client master, so the walk creates one (`order_taker` is a `vendors` writeRole).

Two preconditions the walk handles itself, learned by running it: it opens a
shift when no machine has one (`verify:tenancy` closes M-01's shift as part of
its own run, so one can't be assumed left over), and it only considers machines
whose `managed_by` is the floor manager's own uid — `fm_open_shift` and
`fm_assign_machine` both refuse an unmanaged (`null`) machine to a floor manager,
even though `fm_shifts_for_date` lists it.

Also: `npm run check:migrations` — every detectable migration applied, 0048–0052
now probed. 0050 and 0052 are body-only changes to functions whose signatures
didn't move, so the probe can't distinguish them from their predecessors; their
entries say so, and the walk is what proves the behaviour is live.

`tsc --noEmit` clean. Web bundle builds (931 modules) with all seven guidance
strings present.

### A latent bug in the verify suite itself, found while running it

`npm run verify:tenancy` was reporting **20 failures**. Seventeen of them were
one bug — in the *suite*, not the app.

Section 30 picked the job card to issue materials against with
`queue.body?.[0]`. `material_issue_queue` is `order by confirmed_at` **ascending**,
so the head of that queue is the *oldest unissued card in the factory* — which,
on a project carrying test data from earlier sessions, is somebody else's order.
The suite therefore issued and accepted materials for an unrelated order, while
`alphaRun`'s order (created in section 19, and what sections 36b/36c/36d all key
off) never left `job_card_confirmed`. Every later assertion about assigning a
machine, starting production, and the whole stage-tracking loop then failed on
an order that had never been issued materials — a cascade that reads like a
broken lifecycle and is really one wrong array index.

Fixed by selecting this run's own order:

```js
const jcRow = (queue.body ?? []).find((r) => r.order_id === alphaRun.orderId);
```

**403 passed, 3 failed** after the fix. The remaining three are pre-existing and
none is a tenancy leak:

| Failure | Reality |
|---|---|
| "Super admin sees both factories (3)" | A third factory, `new factory`, was created 2026-07-31 through the Super Admin flow. The assertion hardcodes 2. Test-data drift. |
| "every non-opening movement references the event that caused it" | 16 `issue` movements with a null `ref_code`, newest 2026-08-01T14:01 — all before this change set. Worth a look on its own. |
| "Beta owner cannot read Alpha's employee_compensation" | Beta owner sees **9 rows, 0 of them Alpha's**. No leak. The assertion demands an empty array, but an owner reading their *own* factory's compensation is correct — the assertion is wrong, not the policy. |

Left alone deliberately: all three are outside this change set, and #1 and #3
are assertions to correct rather than behaviour to change. Flagging rather than
silently "fixing" a suite that would then stop asking a real question.

---

## Project structure

```
src/
  api/               client.ts (only file that imports supabase)
                     endpoints/ (auth, profiles, factories, masters) — thin per-resource layer
  auth/              AuthContext (session + profile + factory + modules)
  masters/           types.ts (entity-config contract) + configs.ts (one object per entity)
  navigation/        RootNavigator → RoleRouter → roles/ (11 role navigators)
                     roles/roleMasters.ts (which masters each role reaches)
  screens/
    shared/          LoginScreen, RoleHomeScreen
    masters/         MasterListScreen, MasterFormScreen (generic — serve all entities)
  components/
    ui/              AppHeader, Screen, AppButton, StitchLine
    forms/           TextField, SelectField (select + linked-record)
    lists/           ListRow, SearchBar
  constants/         theme.ts (design system), roles.ts (11 roles + 4 modules)
  models/            types.ts (DB row types)
  utils/             permissions.ts, errors.ts (DB error → plain language)
scripts/
  verify-tenancy.mjs Tenancy/RLS regression suite — extend it every phase
supabase/
  migrations/        0001 schema+RLS, 0002 seed, 0003(+b) dev users,
                     0004 auth repair, 0005 masters+RLS, 0006 factory_id default
```

**Architecture rule:** no screen or component calls Supabase directly — everything
goes through `src/api/endpoints/*`.
