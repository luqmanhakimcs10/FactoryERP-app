-- =============================================================================
-- Factory ERP — clear every order, material request and purchase order, and
-- put stock back to what was entered by hand.
--
-- !!! DEVELOPMENT DATABASES ONLY. This is not reversible. !!!
--
-- This is the "start the walkthrough from nothing" reset. Masters, profiles,
-- module toggles, shifts, payroll and the stock a human typed in all survive.
--
-- HOW THIS DIFFERS FROM delete_all_orders.sql
-- -------------------------------------------
-- 1. That file keeps purchase orders a person raised by hand with no order
--    attached. This one deletes ALL of them, which is what "remove all the POs"
--    means. On the database this was written against that is 34 POs, not 7.
--
-- 2. That file's optional stock block keeps ONLY movement_type = 'opening', on
--    the stated assumption that opening is the one movement not caused by an
--    order. That assumption is FALSE here, and running it would have been
--    destructive: checked against the live table, there is exactly 1 'opening'
--    row covering 1 item, while 96 of the 97 inventory items were stocked with
--    'manual_add' (149 rows over 91 items). Keeping only 'opening' would zero
--    the balance of 96 items — losing the stock, not restoring it.
--
--    So the line here is drawn at *who caused the movement*, not at one magic
--    type. Kept: 'opening' and 'manual_add', the two a store manager enters
--    directly. Deleted: 'issue', 'grn', 'audit_variance', 'handover_return',
--    each of which only exists because of an order, a PO or an audit.
--
-- WHAT CASCADES ON ITS OWN  (verified against information_schema, not assumed)
-- ---------------------------------------------------------------------------
-- Every FK into orders is `on delete cascade` and NOT NULL except two, so
-- `delete from orders` clears all of these and they are not repeated below:
--
--   sheets -> repeats -> repeat_stage_history
--   order_stages
--   job_cards -> job_card_lines
--   damage_records
--   material_issues -> material_issue_items
--   material_requests        <-- "requests". order_id is NOT NULL + cascade,
--                                so there is no such thing as a request that
--                                outlives its order.
--   fm_handovers -> fm_handover_items
--   invoices
--
-- The two exceptions, both `set null`:
--   purchase_orders.order_id   handled explicitly in step 1.
--   shifts.order_id            deliberately KEPT. A shift is a workforce and
--                              payroll record, not an order artefact, and
--                              machine assignment needs an open one. Only the
--                              order link is cleared, by the set null.
--
-- WHAT IS DELIBERATELY LEFT ALONE
-- -------------------------------
--   masters (clients, suppliers, machines, partners), profiles, module toggles,
--   shifts, worker_ledger, expenses, payments, inventory_items themselves.
--
-- Run with:  supabase db query --linked -f supabase/maintenance/reset_orders_requests_and_pos.sql
-- or paste whole into the Supabase SQL editor.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Purchase orders — all of them, with their items and GRNs.
--
-- Done BEFORE the orders, because `purchase_orders.order_id` is `set null` and
-- afterwards there is no way to tell which PO belonged to which order.
--
-- grns.purchase_order_id is `set null` too, NOT cascade, so the GRNs have to go
-- explicitly or they survive as receipts against a PO that no longer exists.
-- Column is `purchase_order_id`, not `po_id` — 0073 exists because that was got
-- wrong once; re-checked against the live catalogue.
-- ---------------------------------------------------------------------------
delete from public.grn_items;
delete from public.grns;
delete from public.po_items;
delete from public.purchase_orders;

-- ---------------------------------------------------------------------------
-- 2. Machine mounts. Every one exists because material was issued for an order,
--    and job_card_id is `set null`, so they would otherwise survive as colours
--    on the "On Machine" board with nothing behind them.
-- ---------------------------------------------------------------------------
delete from public.machine_mounted_items;

-- ---------------------------------------------------------------------------
-- 3. SLA alerts, if present — they hang off repeats/stages and depending on the
--    migration that created them may not cascade.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.sla_alerts') is not null then
    execute 'delete from public.sla_alerts';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The orders. Everything in the CASCADES list above goes with them,
--    material_requests included.
--
-- To limit this to ONE factory, add:  where factory_id = '1111...1111' (Alpha)
--                                     or  '2222...2222' (Beta)
-- ---------------------------------------------------------------------------
delete from public.orders;

-- ---------------------------------------------------------------------------
-- 5. Stock audits, and the movements that orders / POs / audits caused.
--
-- See the header for why this is NOT `where movement_type <> 'opening'`.
-- Listed positively so a movement type added later is KEPT by default rather
-- than silently deleted by a catch-all.
-- ---------------------------------------------------------------------------
delete from public.stock_audit_items;
delete from public.stock_audits;

-- Which items the ledger currently accounts for, captured BEFORE the delete.
-- Step 6 needs to tell two look-alike states apart afterwards, and once the rows
-- are gone it cannot:
--   - an item that never had a ledger row (balance predates the ledger) -> leave
--   - an item whose every row was just deleted (stock came from a deleted GRN)
--     -> recompute, which correctly takes it to 0
-- Both end up with zero movements, so "has no movements now" cannot decide it.
create temporary table _ledger_items on commit drop as
  select distinct thread_stock_id from public.stock_movements
   where thread_stock_id is not null;

delete from public.stock_movements
 where movement_type in ('issue', 'grn', 'audit_variance', 'handover_return');

-- ---------------------------------------------------------------------------
-- 6. Rebuild the ledger so it still reconciles.
--
-- Two halves, and doing only one breaks the Stock Ledger screen, which prints
-- the ledger's own `balance_after` precisely so that a disagreement with the
-- item balance is visible rather than hidden:
--
--   a) balance_after on every surviving row — the kept manual_add rows were
--      numbered while issues were interleaved between them, so their running
--      balance is now wrong even though the rows themselves are fine.
--   b) inventory_items.quantity — recomputed from what survives.
-- ---------------------------------------------------------------------------
with running as (
  select id,
         sum(quantity_meters) over (
           partition by thread_stock_id
           order by created_at, id
           rows between unbounded preceding and current row
         ) as new_balance
    from public.stock_movements
)
update public.stock_movements sm
   set balance_after = r.new_balance
  from running r
 where r.id = sm.id
   and sm.balance_after is distinct from r.new_balance;

-- Scoped to _ledger_items, and that scope is load-bearing rather than defensive
-- noise. Three seeded items (BLK-03, GLD-02, RED-01) carry 120,000 m each in
-- both factories and have NO ledger rows at all — their balances predate the
-- ledger. An unscoped `coalesce(sum(...), 0)` reads "no movements" as "no
-- stock" and zeroes them, destroying stock no order ever touched.
--
-- Scoping on movements that survive is equally wrong in the other direction:
-- TST-8/21/93 were stocked purely by a GRN deleted above, so they end with no
-- rows and would keep 1,500 m the ledger no longer backs — the empty-ledger-
-- with-a-balance state the Stock Ledger screen exists to expose. Taking the
-- membership from before the delete separates the two, and takes those to 0.
update public.inventory_items ii
   set quantity = coalesce((
         select sum(sm.quantity_meters)
           from public.stock_movements sm
          where sm.thread_stock_id = ii.id
       ), 0),
       updated_at = now()
 where ii.id in (select thread_stock_id from _ledger_items);

-- ---------------------------------------------------------------------------
-- 7. Restart the counters.
--
-- Safe only because every table these number is now empty — a counter restarted
-- while rows survive collides on the unique code index. order_seq, po_seq,
-- grn_seq, issue_seq, request_seq, handover_seq, invoice_seq and audit_seq all
-- qualify after the deletes above.
-- ---------------------------------------------------------------------------
update public.factory_counters
   set order_seq    = 0,
       po_seq       = 0,
       grn_seq      = 0,
       issue_seq    = 0,
       request_seq  = 0,
       handover_seq = 0,
       invoice_seq  = 0,
       audit_seq    = 0;

commit;
