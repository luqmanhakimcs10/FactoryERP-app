-- =============================================================================
-- Factory ERP — remove the throwaway rows left by verify-store-manager.mjs and
-- drive-to-handover.mjs.
--
-- !!! DEVELOPMENT DATABASES ONLY. Never run against production. !!!
--
-- WHY THIS IS A MAINTENANCE SCRIPT AND NOT SCRIPT CLEANUP
-- ------------------------------------------------------
-- Same reason as cleanup_test_data.sql: the client genuinely cannot delete this.
-- `inventory_items` and `stock_movements` have no DELETE policy at all, by
-- design — the ledger is append-only and a stock balance is a business record.
-- Weakening that so a test could tidy up would be a bad trade, so cleanup runs
-- here as the table owner instead.
--
-- The suites have also been changed so they stop producing this in the first
-- place: verify-store-manager now uses a FIXED tag (VFY) and tops the same five
-- rows up rather than minting new ones per run. This file is for the backlog
-- already accumulated from when the tag was a timestamp.
--
-- WHAT IT MATCHES, AND WHAT IT DELIBERATELY DOES NOT
-- --------------------------------------------------
-- Only colour codes of the form V?-XXXXX, which is the suite's own naming and
-- cannot collide with a real thread code:
--   VT- thread   VL- tilla    VB- bobbin
--   VD- decimal  VS- sequin   VX- refused-size probe   VR- role probe
--
-- Real stock (RED-01, GLD-02, BLK-03, WHT-04 and anything a person typed) is
-- untouched. So are all orders — including the ones drive-to-handover created.
-- Those carry genuine repeats, stage history and job cards, which is exactly the
-- data that makes the app demonstrable; deleting them would be destroying the
-- thing the driving was for. Only the PURCHASE ORDERS the suite raised are
-- removed, matched on their own note.
--
-- Run via the session pooler (the direct host is IPv6-only):
--   psql "postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
--        -f supabase/maintenance/cleanup_store_manager_test_data.sql
-- or paste it whole into the Supabase SQL editor.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Before: what is about to go.
-- ---------------------------------------------------------------------------
select 'before' as when_, count(*) as tagged_inventory_rows
  from public.inventory_items
 where color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

-- ---------------------------------------------------------------------------
-- 1. Ledger rows for the tagged items.
--
-- Deleted BEFORE the items themselves. stock_movements.thread_stock_id is ON
-- DELETE CASCADE so this would happen anyway, but doing it explicitly means the
-- row counts below are honest about what was removed rather than hiding it in a
-- cascade.
-- ---------------------------------------------------------------------------
delete from public.stock_movements sm
 using public.inventory_items ii
 where ii.id = sm.thread_stock_id
   and ii.color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

-- Any machine mount pointing at a tagged item (also cascades; same reasoning).
delete from public.machine_mounted_items mm
 using public.inventory_items ii
 where ii.id = mm.inventory_item_id
   and ii.color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

-- Audit lines that counted a tagged item. The audit HEADER is kept: it is a
-- signed-off record of a real count, and the history list should not develop
-- holes just because some of the items counted were test rows.
delete from public.stock_audit_items sai
 using public.inventory_items ii
 where ii.id = sai.inventory_item_id
   and ii.color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

-- Handover lines referencing a tagged item.
delete from public.fm_handover_items hi
 using public.inventory_items ii
 where ii.id = hi.inventory_item_id
   and ii.color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

-- PO lines pointing at a tagged item, so the PO delete below is unobstructed.
update public.po_items pi
   set inventory_item_id = null
  from public.inventory_items ii
 where ii.id = pi.inventory_item_id
   and ii.color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

-- ---------------------------------------------------------------------------
-- 2. The items.
-- ---------------------------------------------------------------------------
delete from public.inventory_items
 where color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

-- ---------------------------------------------------------------------------
-- 3. The purchase orders the suite raised.
--
-- Matched on the note it writes ("verify <TAG>") plus the manual-with-no-lines
-- shape it leaves behind. NOT matched on "manual" alone — a real store manager
-- raising a PO by hand must never be swept up by a cleanup script.
-- ---------------------------------------------------------------------------
delete from public.po_items
 where purchase_order_id in (
   select id from public.purchase_orders
    where origin = 'manual'
      and (notes like 'verify %' or notes like '%handover drive%')
 );

delete from public.purchase_orders
 where origin = 'manual'
   and (notes like 'verify %' or notes like '%handover drive%');

commit;

-- ---------------------------------------------------------------------------
-- After: what the store manager will now see.
-- ---------------------------------------------------------------------------
select 'after' as when_, count(*) as tagged_inventory_rows
  from public.inventory_items
 where color_code ~ '^V[TLBDSXR]-[A-Z0-9]{3,6}$';

select f.code_prefix, ii.item_type, ii.color_code, ii.quantity, ii.unit, ii.source
  from public.inventory_items ii
  join public.factories f on f.id = ii.factory_id
 order by f.code_prefix, ii.item_type, ii.color_code;

select count(*) as purchase_orders_left, origin
  from public.purchase_orders
 group by origin
 order by origin;
