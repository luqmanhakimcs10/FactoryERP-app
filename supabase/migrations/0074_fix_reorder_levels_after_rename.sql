-- =============================================================================
-- Factory ERP — fix: setting a reorder level has been broken since 0068.
--
-- WHAT I GOT WRONG IN 0068
-- -----------------------
-- 0068's header claims "every existing reader and writer keeps working,
-- unchanged, through the view". True for SELECT, INSERT and UPDATE. NOT true for
-- `ON CONFLICT (factory_id, color_code)`, and not true for anything that used
-- `public.thread_stock` as a TYPE.
--
-- 1. THE CONFLICT TARGET
-- A named conflict target must match a unique index EXACTLY, and 0068 dropped
-- `unique (factory_id, color_code)` on purpose: colour stopped identifying a row
-- the moment a red thread and a red tilla could both exist. Nothing can make
-- `(factory_id, color_code)` infer the replacement, and no index should — that
-- would mean forbidding the second red item, which is the point of the change.
-- `sm_set_reorder_levels` upserts on that target, so it fails with 42P10.
--
-- 2. THE COMPOSITE TYPE MOVED WITH THE TABLE
-- A table's row type shares its name, so `alter table thread_stock rename to
-- inventory_items` renamed the TYPE too. The old function declared
-- `returns public.thread_stock`, which now resolves to inventory_items' 15-column
-- row type, while the freshly created view owns a NEW 10-column type of the same
-- name. That is why a plain `create or replace` raises 42P13: the return type
-- genuinely differs. It also means the old function was broken twice over —
-- `returning * into v_stock` was putting 10 view columns into a 15-column record.
--
-- WHY THIS RETURNS A TABLE AND NOT `public.thread_stock`
-- -----------------------------------------------------
-- The obvious fix is `drop function` then re-create it `returns
-- public.thread_stock`. That works once and plants a worse trap: the function
-- would then depend on the VIEW's composite type, and 0068 does
-- `drop view if exists public.thread_stock` before re-creating it. Re-running
-- 0068 — which is the normal way these get applied, and which its own idempotency
-- notes invite — would fail with "cannot drop view because other objects depend
-- on it". Migrations that cannot be re-applied in any order are how a database
-- ends up unrecoverable.
--
-- An explicit column list depends on nothing. The columns are the ten the view
-- exposes, in its order, so the shape the app already knows is unchanged; the
-- read is from the base table so no view is involved at all.
--
-- The one caller (StockLedgerScreen) ignores the returned row and just
-- invalidates its query, so moving from one composite to a one-row table costs
-- nothing at the call site beyond taking `[0]`.
--
-- Reorder levels stay thread-only: nothing in the brief asks to set them per
-- sequin size, and `log_inventory_movement` already honours the column for any
-- item type if that changes.
-- =============================================================================

-- Required, not defensive: the return type differs from the existing function's
-- (see note 2 above), so `create or replace` cannot do it.
drop function if exists public.sm_set_reorder_levels(text, numeric, numeric);

create function public.sm_set_reorder_levels(
  p_color_code        text,
  p_reorder_threshold numeric default null,
  p_reorder_quantity  numeric default null
)
returns table (
  id                uuid,
  factory_id        uuid,
  color_code        text,
  quantity_meters   numeric,
  created_at        timestamptz,
  updated_at        timestamptz,
  color_name        text,
  photo_url         text,
  reorder_threshold numeric,
  reorder_quantity  numeric
)
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_id      uuid;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager', 'company_admin']);

  if v_factory is null then
    raise exception 'Your profile has no factory.' using errcode = '42501';
  end if;
  if coalesce(trim(p_color_code), '') = '' then
    raise exception 'A colour code is required.' using errcode = '22023';
  end if;
  if p_reorder_threshold is not null and p_reorder_threshold < 0 then
    raise exception 'Reorder threshold cannot be negative.' using errcode = '22023';
  end if;
  if p_reorder_quantity is not null and p_reorder_quantity <= 0 then
    raise exception 'Reorder quantity must be greater than zero.' using errcode = '22023';
  end if;

  -- Find-then-write instead of an upsert. Re-targeting the new expression index
  -- would work today and break again the next time the identity of an inventory
  -- row is refined; naming the row states the intent ("the thread of this
  -- colour") rather than encoding it in an index signature. `for update` gives
  -- the same protection against a concurrent second call that the upsert did.
  select ii.id into v_id
    from public.inventory_items ii
   where ii.factory_id = v_factory
     and ii.item_type = 'thread'
     and ii.color_code = p_color_code
   for update;

  -- Setting a level for a colour never stocked before still works, exactly as
  -- the upsert allowed: the row is created at zero and the level attached.
  if v_id is null then
    insert into public.inventory_items
      (factory_id, item_type, color_code, quantity, unit, source,
       reorder_threshold, reorder_quantity)
    values
      (v_factory, 'thread', p_color_code, 0, public.inventory_unit('thread'), 'po',
       p_reorder_threshold, p_reorder_quantity)
    returning inventory_items.id into v_id;
  else
    update public.inventory_items ii
       set reorder_threshold = p_reorder_threshold,
           reorder_quantity  = p_reorder_quantity,
           updated_at        = now()
     where ii.id = v_id;
  end if;

  return query
    select ii.id, ii.factory_id, ii.color_code, ii.quantity,
           ii.created_at, ii.updated_at, ii.color_name, ii.photo_url,
           ii.reorder_threshold, ii.reorder_quantity
      from public.inventory_items ii
     where ii.id = v_id;
end $$;

grant execute on function public.sm_set_reorder_levels(text, numeric, numeric) to authenticated;
