-- =============================================================================
-- Factory ERP — reset the database to the SEED BASELINE.
--
-- !!! DEVELOPMENT DATABASES ONLY. Never run against production. !!!
--
-- Unlike cleanup_test_data.sql (which picks off rows by test-marker name), this
-- empties every operational and master table outright and puts the tenant-level
-- one-time gates back to their pre-first-use state. What you are left with is a
-- database you can sign into and drive from scratch: two factories, the 21
-- seeded logins, roles, module toggles, and nothing else.
--
-- KEPT
--   roles, modules                        reference data (0002)
--   factories                             ONLY Alpha + Beta; any other factory
--                                         created since is deleted
--   factory_modules                       Beta still has Machine & Workforce and
--                                         Finance & Reports disabled, which is
--                                         what makes module-gating testable
--   profiles + auth.users                 ONLY the 21 seeded @alpha.test /
--                                         @beta.test / super@erp.test accounts
--   bonus_slabs                           Alpha's two payroll slabs are seed
--                                         data (0018), not test residue
--
-- DELETED
--   every order and everything downstream of it — sheets, repeats, stages,
--   stage history, job cards, damage, returns
--   all inventory & procurement — issues, POs, GRNs, stock movements, audits
--   all workforce & finance — shifts, ledgers, loans, leaves, invoices,
--   payments, expenses, compensation, SLA alerts
--   all masters — vendors, suppliers, machines, finishing partners, thread stock
--   every employee account added through the app (auth user + profile)
--
-- NOT TOUCHED
--   storage.objects. Old order/return photos stay in their buckets. Nothing in
--   the app references them once the rows above are gone, so they are invisible;
--   empty the buckets from the Supabase dashboard if you want the space back.
--
-- Three resets at the end matter as much as the deletes — each is a one-time
-- gate that, left alone, would strand a role with no way forward:
--   1. factories.opening_stock_completed_at -> null. Opening stock can only be
--      entered while this is null (0013). Wiping thread_stock without clearing
--      it leaves the store manager with an empty ledger and no way to fill it.
--   2. factories.account_status -> 'active'. Beta was left 'inactive' by a super
--      admin test; my_factory_active() signs every @beta.test login straight
--      back out, which reads as "login is broken" rather than "factory is off".
--   3. factory_counters -> 0. So the first new order is ALP-0001, not ALP-0106.
--
-- Run it in the Supabase dashboard SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run), the same way the migrations were applied. It needs
-- owner rights: truncating these tables and deleting auth users is not
-- something the anon key can do, by design.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Operational + master data.
--
-- One multi-table TRUNCATE, deliberately WITHOUT CASCADE. Every table holding a
-- foreign key into this set is itself in the list, so this succeeds as written;
-- if a future migration adds a table that references one of these and it is not
-- added here, Postgres raises instead of quietly truncating it too. A loud
-- failure is the better outcome.
-- ---------------------------------------------------------------------------
-- Built dynamically ONLY so that a table a migration has not created yet is
-- skipped instead of aborting the whole reset. This script has twice been run
-- against a database part-way through a migration batch, and a single missing
-- relation takes the entire truncate down with it.
--
-- This does NOT weaken the guarantee in the note above: a table that EXISTS and
-- references one of these but is missing from the list still makes Postgres
-- raise, which is what should happen. Only genuinely absent tables are skipped,
-- and each one is named in a notice so a silent skip cannot be mistaken for a
-- successful clear.
do $reset$
declare
  wanted text[] := array[
      'public.orders',
      'public.sheets',
      'public.repeats',
      'public.order_stages',
      'public.repeat_stage_history',
      'public.job_cards',
      'public.job_card_lines',
      'public.damage_records',
      'public.sla_alerts',
      'public.material_issues',
      'public.material_issue_items',
      'public.purchase_orders',
      'public.po_items',
      'public.grns',
      'public.grn_items',
      'public.stock_movements',
      'public.stock_audits',
      'public.stock_audit_items',
      'public.inventory_items',
      'public.machine_mounted_items',
      'public.material_requests',
      'public.fm_handovers',
      'public.fm_handover_items',
      'public.shifts',
      'public.downtime_reports',
      'public.worker_ledger',
      'public.partner_ledger',
      'public.leaves',
      'public.loans',
      'public.employee_compensation',
      'public.bonus_slab_proposals',
      'public.invoices',
      'public.payments',
      'public.expenses',
      'public.user_permissions',
      'public.vendors',
      'public.suppliers',
      'public.machines',
      'public.finishing_partners'
  ];
  present text[] := '{}';
  t text;
begin
  foreach t in array wanted loop
    if to_regclass(t) is null then
      raise notice 'skipping %: not in this database yet', t;
    else
      present := present || t;
    end if;
  end loop;

  execute 'truncate table ' || array_to_string(present, ', ') || ' restart identity';
end $reset$;

-- ---------------------------------------------------------------------------
-- 2. Factories created since the seed.
--
-- Alpha and Beta have fixed UUIDs (0002) precisely so they can be told apart
-- from anything made later. Deleting a factory cascades its factory_modules,
-- factory_counters and profiles; the orphaned auth users are swept in step 3.
-- ---------------------------------------------------------------------------
delete from public.factories
where id not in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222'
);

-- ---------------------------------------------------------------------------
-- 3. Accounts added through the app.
--
-- add_employee (0030) writes straight into auth.users, so every employee made
-- from the owner's Masters -> Employees screen is a real auth user. Deleting
-- from auth.users cascades to auth.identities and public.profiles.
-- ---------------------------------------------------------------------------
delete from auth.users
where email not in (
  'super@erp.test',
  'owner@alpha.test',      'owner@beta.test',
  'accountant@alpha.test', 'accountant@beta.test',
  'floor@alpha.test',      'floor@beta.test',
  'store@alpha.test',      'store@beta.test',
  'order@alpha.test',      'order@beta.test',
  'qa@alpha.test',         'qa@beta.test',
  'procurement@alpha.test','procurement@beta.test',
  'delivery@alpha.test',   'delivery@beta.test',
  'worker@alpha.test',     'worker@beta.test',
  'partner@alpha.test',    'partner@beta.test'
);

-- ---------------------------------------------------------------------------
-- 4. Order / PO code sequences back to zero.
-- The insert covers the case where a counter row is missing entirely.
-- ---------------------------------------------------------------------------
insert into public.factory_counters (factory_id)
select id from public.factories
on conflict (factory_id) do nothing;

update public.factory_counters set order_seq = 0, po_seq = 0;

-- ---------------------------------------------------------------------------
-- 5. Tenant-level one-time gates.
-- ---------------------------------------------------------------------------
update public.factories
   set opening_stock_completed_at = null,
       opening_stock_completed_by = null,
       account_status             = 'active';

commit;

-- ---------------------------------------------------------------------------
-- What's left. Expect: 2 factories, 21 profiles, 0 everywhere else.
-- ---------------------------------------------------------------------------
select 'factories' as what, count(*) from public.factories
union all select 'profiles',           count(*) from public.profiles
union all select 'auth users',         count(*) from auth.users
union all select 'roles',              count(*) from public.roles
union all select 'modules enabled',    count(*) from public.factory_modules where enabled
union all select 'orders',             count(*) from public.orders
union all select 'vendors',            count(*) from public.vendors
union all select 'suppliers',          count(*) from public.suppliers
union all select 'machines',           count(*) from public.machines
union all select 'finishing partners', count(*) from public.finishing_partners
-- Only tables guaranteed to exist by 0068, which this script already requires.
-- The post-0069 tables (material_requests, machine_mounted_items, fm_handovers)
-- are deliberately NOT counted here: this whole script runs as one transaction
-- in the SQL editor, so a missing relation in this final report would roll the
-- truncate above back. The truncate names any table it skipped in a notice.
union all select 'inventory items',    count(*) from public.inventory_items
union all select 'stock movements',    count(*) from public.stock_movements
order by 1;

select f.name,
       f.code_prefix,
       f.account_status,
       f.opening_stock_completed_at,
       c.order_seq,
       c.po_seq
from public.factories f
join public.factory_counters c on c.factory_id = f.id
order by f.name;
