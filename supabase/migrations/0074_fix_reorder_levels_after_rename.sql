-- =============================================================================
-- Factory ERP — fix: setting a reorder level has been broken since 0068.
--
-- WHAT I GOT WRONG IN 0068
-- -----------------------
-- 0068's header claims "every existing reader and writer keeps working,
-- unchanged, through the view". That is true for SELECT, INSERT and UPDATE. It
-- is NOT true for `ON CONFLICT (factory_id, color_code)`.
--
-- A named conflict target has to match a unique index EXACTLY, and 0068 dropped
-- `unique (factory_id, color_code)` on purpose: colour alone stopped identifying
-- a row the moment a red thread and a red tilla could both exist, so the new
-- index is (factory_id, item_type, color_code, coalesce(size_mm,-1),
-- lower(coalesce(sequin_type,''))). Nothing can make `(factory_id, color_code)`
-- infer that, and no index could — allowing it would mean forbidding the second
-- red item, which is the whole point of the change.
--
-- So the two statements that named that target broke with 42P10:
--
--   0009's thread-stock seed   -> fixed in place; a seed only ever wanted
--                                 "skip duplicates", and bare DO NOTHING needs
--                                 no inference, so that file now works against
--                                 both the old table and the new view.
--
--   sm_set_reorder_levels      -> here. It uses DO UPDATE, which REQUIRES a
--                                 target, so it cannot be fixed by dropping one.
--
-- WHY THIS VERSION HAS NO ON CONFLICT AT ALL
-- ------------------------------------------
-- Rewriting it as `on conflict (factory_id, item_type, color_code, ...)` would
-- work today and break again the next time the identity of an inventory row is
-- refined — expression indexes are especially brittle to infer against. Finding
-- the row explicitly states the intent ("the thread of this colour") instead of
-- encoding it in an index signature, and `for update` gives the same protection
-- against a concurrent second call that the upsert did.
--
-- The signature and return type are unchanged, so `setReorderLevels` in
-- src/api/endpoints/inventory.ts and the ThreadStock type it returns need no
-- edit. Reorder levels remain thread-only for now: nothing in the brief asks to
-- set them per sequin size, and log_inventory_movement already honours the
-- column for any item type if that changes.
-- =============================================================================

create or replace function public.sm_set_reorder_levels(
  p_color_code        text,
  p_reorder_threshold numeric default null,
  p_reorder_quantity  numeric default null
)
returns public.thread_stock
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_stock   public.thread_stock;
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

  select id into v_id
    from public.inventory_items
   where factory_id = v_factory
     and item_type = 'thread'
     and color_code = p_color_code
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
    returning id into v_id;
  else
    update public.inventory_items
       set reorder_threshold = p_reorder_threshold,
           reorder_quantity  = p_reorder_quantity,
           updated_at        = now()
     where id = v_id;
  end if;

  -- Read back through the view so the returned row is the shape the caller's
  -- type already describes.
  select * into v_stock from public.thread_stock where id = v_id;
  return v_stock;
end $$;

grant execute on function public.sm_set_reorder_levels(text, numeric, numeric) to authenticated;
