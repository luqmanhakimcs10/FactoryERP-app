-- =============================================================================
-- Factory ERP — delete every order and everything that belongs to one.
--
-- !!! DEVELOPMENT DATABASES ONLY. This is not reversible. !!!
--
-- For starting a walkthrough from scratch without wiping masters, stock, users
-- or module settings. If you want the FULL reset (masters and stock too), use
-- reset_to_seed_baseline.sql instead — this is the narrower one.
--
-- WHAT CASCADES ON ITS OWN
-- ------------------------
-- These have `on delete cascade` from orders, so `delete from orders` clears
-- them and they are NOT listed again below:
--
--   sheets -> repeats -> repeat_stage_history
--   order_stages
--   job_cards -> job_card_lines
--   damage_records
--   material_issues -> material_issue_items
--   material_requests
--   fm_handovers -> fm_handover_items
--   invoices
--
-- WHAT DOES *NOT*, AND IS HANDLED EXPLICITLY
-- ------------------------------------------
-- Three things survive a plain `delete from orders`, which is the whole reason
-- this file exists rather than a one-liner:
--
--   purchase_orders.order_id   on delete SET NULL -> 25 POs would be left
--                              pointing at nothing, still listed in the PO tab
--                              and on procurement's dashboard.
--   shifts.order_id            on delete SET NULL -> deliberately KEPT. A shift
--                              is a workforce and payroll record, not an order
--                              artefact, and machine assignment needs an open
--                              one. Only the order link is cleared.
--   machine_mounted_items      job_card_id is SET NULL, so mounts would survive
--                              with nothing to explain them, and "On Machine"
--                              would keep showing colours from deleted orders.
--
-- WHAT IS DELIBERATELY LEFT ALONE
-- -------------------------------
--   stock_movements and inventory balances. Removing them is a bigger decision
--   than it looks and is not part of "delete the orders" — see the note at the
--   end of this file, and use reset_orders_requests_and_pos.sql if you want the
--   balances restored as well.
--   masters (clients, suppliers, machines, partners), profiles, module toggles.
--
-- Run via the session pooler, or paste whole into the Supabase SQL editor:
--   psql "postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
--        -f supabase/maintenance/delete_all_orders.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. What is about to go. Read this before committing.
-- ---------------------------------------------------------------------------
select f.code_prefix,
       count(*)                                                    as orders,
       count(*) filter (where o.status = 'draft')                   as drafts,
       count(*) filter (where o.status not in ('draft','completed','cancelled')) as in_flight,
       count(*) filter (where o.status = 'completed')               as completed
  from public.orders o
  join public.factories f on f.id = o.factory_id
 group by f.code_prefix
 order by f.code_prefix;

begin;

-- ---------------------------------------------------------------------------
-- 1. Order-linked purchase orders, and their GRNs.
--
-- Done BEFORE the orders, while the link still exists — afterwards order_id is
-- null and there is no way to tell an order's auto-shortfall PO from one raised
-- by hand months ago.
--
-- `auto_created` is included because 0046's reorder POs have no order_id at all
-- but are equally machine-generated residue. A PO a person raised manually with
-- no order attached is NOT touched.
-- ---------------------------------------------------------------------------
create temporary table _po_doomed as
  select id from public.purchase_orders
   where order_id is not null
      or auto_created;

delete from public.grn_items
 where grn_id in (select id from public.grns where purchase_order_id in (select id from _po_doomed));

-- `purchase_order_id`, NOT `po_id`. 0073 exists because I got this wrong once
-- already; checked against the live catalogue this time rather than typed from
-- memory.
delete from public.grns
 where purchase_order_id in (select id from _po_doomed);

delete from public.po_items
 where purchase_order_id in (select id from _po_doomed);

delete from public.purchase_orders
 where id in (select id from _po_doomed);

-- ---------------------------------------------------------------------------
-- 2. Machine mounts. Every one exists because material was issued for an order.
-- ---------------------------------------------------------------------------
delete from public.machine_mounted_items;

-- ---------------------------------------------------------------------------
-- 3. SLA alerts, if that table is present — they hang off repeats/stages and
--    (depending on the migration that made them) may not cascade.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.sla_alerts') is not null then
    execute 'delete from public.sla_alerts';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The orders. Everything in the CASCADES list above goes with them.
--
-- To limit this to ONE factory, add:  where factory_id = '1111...1111'  (Alpha)
--                                     or  '2222...2222'  (Beta)
-- ---------------------------------------------------------------------------
delete from public.orders;

-- ---------------------------------------------------------------------------
-- 5. Restart order numbering, so the next order is 00001 again.
--
-- Safe only because every order is now gone: `uq_orders_code` is unique on
-- order_code, and with an empty table there is nothing left to collide with.
-- The other counters (po_seq, issue_seq, audit_seq, ...) are NOT reset — rows
-- they numbered may still exist, and a restarted counter would collide.
-- ---------------------------------------------------------------------------
update public.factory_counters set order_seq = 0;

commit;

-- ---------------------------------------------------------------------------
-- What is left.
-- ---------------------------------------------------------------------------
select 'orders'            as table_, count(*) from public.orders
union all select 'sheets',            count(*) from public.sheets
union all select 'repeats',           count(*) from public.repeats
union all select 'stage history',     count(*) from public.repeat_stage_history
union all select 'job cards',         count(*) from public.job_cards
union all select 'damage records',    count(*) from public.damage_records
union all select 'material issues',   count(*) from public.material_issues
union all select 'material requests', count(*) from public.material_requests
union all select 'purchase orders',   count(*) from public.purchase_orders
union all select 'GRNs',              count(*) from public.grns
union all select 'fm handovers',      count(*) from public.fm_handovers
union all select 'invoices',          count(*) from public.invoices
union all select 'machine mounts',    count(*) from public.machine_mounted_items
union all select 'KEPT: inventory',   count(*) from public.inventory_items
union all select 'KEPT: movements',   count(*) from public.stock_movements
union all select 'KEPT: shifts',      count(*) from public.shifts
union all select 'KEPT: clients',     count(*) from public.vendors
union all select 'KEPT: machines',    count(*) from public.machines
 order by 1;


-- =============================================================================
-- PUTTING STOCK BACK — use reset_orders_requests_and_pos.sql, not this file.
--
-- Deleting the orders does NOT give you your stock back. `stock_movements` has
-- no foreign key to orders — ref_id is a bare uuid — so every 'issue' row
-- survives and every balance stays reduced. That is correct on its own terms:
-- the thread really was consumed.
--
-- This file used to carry a commented-out block for restoring the balances. It
-- has been REMOVED rather than fixed, because running it would have destroyed
-- the stock it claimed to restore, and a loaded gun sitting behind a `--` is
-- one paste away from being fired.
--
-- What it did, and why each part was wrong (measured 2026-08-15, live DB):
--
--   delete from stock_movements where movement_type <> 'opening'
--     Rested on "opening is the one movement type that is not the result of an
--     order". False here: there is exactly 1 'opening' row covering 1 item,
--     while 96 of the 97 inventory_items were stocked with 'manual_add' (149
--     rows over 91 items). The keep-set has to be 'opening' AND 'manual_add'
--     — what a store manager enters directly — with 'issue', 'grn',
--     'audit_variance' and 'handover_return' deleted. Naming the doomed types
--     positively also means a type added later is kept by default rather than
--     silently swept up by a catch-all.
--
--   set quantity = coalesce(sum(movements), 0)
--     Reads "no ledger rows" as "no stock". BLK-03, GLD-02 and RED-01 hold
--     120,000 m each in both factories with no movements at all — balances that
--     predate the ledger. The recompute zeroed all six rows.
--
--   the "prove it reconciles" select
--     Would NOT have caught either bug. It left joins movements and compares
--     the sum to the balance, so an item zeroed down from 120,000 m reconciles
--     0 against 0 and reports 'ok'. A check that passes because both sides were
--     destroyed together is worse than no check.
--
-- The replacement handles the case this one could not see: an item that never
-- had ledger rows and an item whose rows were all just deleted are
-- indistinguishable afterwards, but need opposite treatment. It records which
-- items the ledger covers BEFORE deleting, and recomputes only those. It also
-- rebuilds `balance_after`, which the Stock Ledger screen prints directly.
-- =============================================================================
