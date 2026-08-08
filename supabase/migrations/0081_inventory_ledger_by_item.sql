-- =============================================================================
-- Factory ERP — a ledger keyed by ITEM, because colour stopped identifying one.
--
-- THE BUG 0068 LEFT BEHIND
-- ------------------------
-- `stock_ledger(p_color_code)` (0013) filters `stock_movements` on colour alone.
-- That was exact while every row was thread. Since 0068 a factory can hold a
-- thread and a tilla and a 3 mm sequin all coded RED-01, and the ledger merges
-- all three: one list, one `balance_after` column, jumping between the running
-- balances of different items. Every number in it would look plausible and the
-- sequence would be nonsense.
--
-- The Inventory tab walks straight into it — every row, whatever its type, opened
-- that colour-keyed ledger.
--
-- WHY A NEW FUNCTION RATHER THAN A FIXED ONE
-- ------------------------------------------
-- `stock_ledger` is reached from the thread-stock screen, which is thread-only by
-- construction (it also sets thread reorder levels). Adding a defaulted
-- `p_item_type` would change its signature, and PostgREST resolves overloads by
-- argument name — the existing caller would start missing. So the thread path
-- keeps its function untouched and the general path gets its own, keyed on the
-- thing that actually identifies a row now.
--
-- Same columns in the same order as stock_ledger, so the screen renders either
-- without branching on shape.
-- =============================================================================

-- Column list, names and ORDER copied from stock_ledger (0013) so the screen can
-- render either result without branching on shape. Checked against that
-- function's `returns table` rather than assumed — a first draft of this had
-- `quantity` instead of `quantity_meters`, an extra `id`, and the last three
-- columns in a different order, none of which the types would have caught since
-- PostgREST returns objects keyed by name.
create or replace function public.inventory_ledger(p_item_id uuid)
returns table (
  created_at      timestamptz,
  movement_type   text,
  quantity_meters numeric,
  balance_after   numeric,
  actor           text,
  ref_type        text,
  ref_code        text,
  note            text
)
language sql stable security definer set search_path = public as $$
  select m.created_at,
         m.movement_type,
         m.quantity_meters,
         m.balance_after,
         p.display_name,
         m.ref_type,
         case m.ref_type
           when 'grn'            then (select grn_code   from public.grns             where id = m.ref_id)
           when 'material_issue' then (select issue_code from public.material_issues  where id = m.ref_id)
           when 'stock_audit'    then (select audit_code from public.stock_audits     where id = m.ref_id)
           when 'fm_handover'    then (select handover_code from public.fm_handovers  where id = m.ref_id)
           else null
         end,
         m.note
    from public.stock_movements m
    left join public.profiles p on p.id = m.actor_user_id
   where m.factory_id = public.current_factory_id()
     -- The item, not the colour. This is the whole point of the migration.
     and m.thread_stock_id = p_item_id
   order by m.created_at, m.id
$$;

grant execute on function public.inventory_ledger(uuid) to authenticated;

comment on function public.inventory_ledger(uuid) is
  'Movement history for ONE inventory item. Use this rather than stock_ledger '
  'for anything that is not known to be thread: since 0068 a colour code can '
  'belong to several items and the colour-keyed version merges them.';
