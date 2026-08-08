-- =============================================================================
-- Factory ERP — inventory beyond thread: thread | tilla | sequin | bobbin.
--
-- HOW THIS IS DONE, AND WHY NOT THE OBVIOUS WAY
-- ---------------------------------------------
-- The brief says "extend or replace thread_stock with an inventory_items table".
-- Creating a NEW table beside thread_stock would have been faster to write and
-- would have been wrong: thread stock is read by 11 migrations, both report
-- functions, the leakage ledger and ~30 tenancy assertions. Two tables holding
-- stock is two answers to "how much red thread is there", and the ledger can
-- only reconcile against one of them.
--
-- So this RENAMES the table rather than adding one:
--
--   thread_stock  --rename-->  inventory_items   (ids, FKs, RLS policies,
--                                                 indexes and the stock_movements
--                                                 foreign key all follow)
--   thread_stock  <--view--    inventory_items where item_type = 'thread'
--
-- Every existing reader and writer keeps working, unchanged, through the view.
-- There is exactly one row per physical stock item, and `stock_movements` still
-- points at it. Nothing was copied, so nothing can drift.
--
-- THE VIEW IS `security_invoker = on`
-- -----------------------------------
-- Without it the view would run as its owner and quietly bypass the row-level
-- security on the base table — every factory would read every other factory's
-- stock. With it, the existing policies apply exactly as before, including the
-- deliberate absence of any UPDATE policy (all writes go through the RPCs).
--
-- ONE MEASURE, NOT FOUR
-- ---------------------
-- The brief lists cones for thread, a count for tilla, a count for sequin and a
-- LENGTH for bobbin. Those are four names for one thing: how much is on hand.
-- They live in a single `quantity` column with a `unit` beside it, because four
-- nullable measure columns means every reader has to know which one is real for
-- which type, and any two of them can disagree. `unit` is derived from
-- item_type and stored so the ledger stays readable.
--
-- KNOWN NAMING DEBT
-- -----------------
-- `stock_movements.thread_stock_id` now points at inventory_items and is no
-- longer only thread. It is NOT renamed here: it is asserted by name in the
-- tenancy suite and read by the leakage report, and a rename buys nothing but
-- risk in the same migration that moves the table underneath it. Renaming it is
-- a clean, separate change once this settles.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Two PO columns that belong to 0069, declared here on purpose.
--
-- `log_inventory_movement` below writes both when it auto-raises a reorder PO.
-- A plpgsql body is not checked against the catalogue at CREATE time, so
-- leaving them in 0069 would create cleanly and then fail the first time a
-- movement crossed a reorder threshold. Columns come before the code that
-- writes them, even when it splits a migration's theme.
-- ---------------------------------------------------------------------------
alter table public.purchase_orders
  add column if not exists origin text not null default 'manual';

alter table public.purchase_orders drop constraint if exists purchase_orders_origin_chk;
alter table public.purchase_orders add constraint purchase_orders_origin_chk
  check (origin in ('auto_shortfall','manual'));

-- Existing auto-created POs were all raised by a shortfall check.
update public.purchase_orders set origin = 'auto_shortfall'
 where auto_created and origin <> 'auto_shortfall';

-- (`po_items.inventory_item_id` is added in section 3a — it cannot reference
--  inventory_items until the rename below has happened.)

-- ---------------------------------------------------------------------------
-- 1. The rename
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'thread_stock'
                and c.relkind = 'r')
  then
    alter table public.thread_stock rename to inventory_items;
    alter table public.inventory_items rename column quantity_meters to quantity;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The four types
--
-- `item_type` defaults to 'thread' for ONE reason: it lets the compatibility
-- view stay insertable, so `insert into thread_stock (factory_id, color_code,
-- quantity)` in the existing RPCs still lands as thread without touching them.
-- New code must always pass item_type explicitly — the default is a bridge for
-- the old callers, not a sensible choice for a new one.
-- ---------------------------------------------------------------------------
alter table public.inventory_items
  add column if not exists item_type text not null default 'thread',
  -- How this stock got here. The brief wants a PO vs Manual badge on every row.
  add column if not exists source    text not null default 'manual',
  add column if not exists unit      text not null default 'm',
  -- Sequin only.
  add column if not exists size_mm     int,
  add column if not exists sequin_type text,
  -- Kept so a CD-entered quantity can be shown back as what was actually typed
  -- ("6 CDs at 3 mm"), not just the computed total. The count in `quantity` is
  -- still the one true figure; these two are provenance, never re-derived from.
  add column if not exists cd_count      numeric(14,2),
  add column if not exists yards_per_cd  numeric(14,2);

alter table public.inventory_items drop constraint if exists inventory_items_type_chk;
alter table public.inventory_items add constraint inventory_items_type_chk
  check (item_type in ('thread','tilla','sequin','bobbin'));

alter table public.inventory_items drop constraint if exists inventory_items_source_chk;
alter table public.inventory_items add constraint inventory_items_source_chk
  check (source in ('po','manual'));

-- Only sequin carries a size, and only the three the brief names.
alter table public.inventory_items drop constraint if exists inventory_items_size_chk;
alter table public.inventory_items add constraint inventory_items_size_chk
  check (
    (item_type = 'sequin' and size_mm in (3,5,9))
    or (item_type <> 'sequin' and size_mm is null and sequin_type is null
        and cd_count is null and yards_per_cd is null)
  );

-- Stock is never negative. log_inventory_movement enforces this too; the
-- constraint is the backstop for any path that ever forgets.
alter table public.inventory_items drop constraint if exists inventory_items_qty_chk;
alter table public.inventory_items add constraint inventory_items_qty_chk
  check (quantity >= 0);

/**
 * The unit a type is counted in. Bobbin is metres because a bobbin is tracked by
 * remaining thread length, not by how many bobbins there are — that is the whole
 * point of the brief singling it out.
 */
create or replace function public.inventory_unit(p_item_type text)
returns text language sql immutable as $$
  select case p_item_type
           when 'thread' then 'cones'
           when 'tilla'  then 'pcs'
           when 'sequin' then 'pcs'
           when 'bobbin' then 'm'
           else 'm' end
$$;

update public.inventory_items set unit = public.inventory_unit(item_type)
 where unit is distinct from public.inventory_unit(item_type);

-- (`source` is backfilled in section 5a, once `manual_add` is an allowed
--  movement type — the rule is derived from the ledger, so it has to come after.)

-- ---------------------------------------------------------------------------
-- 3. Identity
--
-- Was unique(factory_id, color_code) — right when everything was thread. A red
-- thread and a red tilla are now different items with the same colour, and two
-- sequins differ by size and type as well.
-- ---------------------------------------------------------------------------
alter table public.inventory_items drop constraint if exists thread_stock_factory_id_color_code_key;
drop index if exists public.thread_stock_factory_id_color_code_key;

create unique index if not exists uq_inventory_identity
  on public.inventory_items (
    factory_id, item_type, color_code,
    coalesce(size_mm, -1),
    lower(coalesce(sequin_type, ''))
  );

create index if not exists idx_inventory_factory_type
  on public.inventory_items (factory_id, item_type, color_code);

-- ---------------------------------------------------------------------------
-- 3a. PO lines can now name a non-thread item
--
-- A tilla or sequin line cannot be identified by colour alone. Nullable, because
-- every historic thread line carries only color_code and must stay valid.
-- ---------------------------------------------------------------------------
alter table public.po_items
  add column if not exists inventory_item_id uuid
    references public.inventory_items(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 4. The compatibility view
--
-- Exposes exactly the old column list under the old names, so `v_stock
-- public.thread_stock%rowtype` and every `select *` in 0013/0028/0046 still
-- resolve. Auto-updatable (single table, no aggregate/distinct/group by), so
-- the existing INSERT and UPDATE statements pass straight through to the base
-- table and are still governed by its RLS.
-- ---------------------------------------------------------------------------
drop view if exists public.thread_stock;
create view public.thread_stock
with (security_invoker = on) as
  select id,
         factory_id,
         color_code,
         quantity as quantity_meters,
         created_at,
         updated_at,
         color_name,
         photo_url,
         reorder_threshold,
         reorder_quantity
    from public.inventory_items
   where item_type = 'thread';

grant select on public.thread_stock to authenticated;
-- Deliberately no INSERT/UPDATE grant to `authenticated`: writes reach the base
-- table only from the SECURITY DEFINER RPCs, exactly as before the rename.

comment on view public.thread_stock is
  'Compatibility view over inventory_items where item_type = ''thread''. '
  'Kept so Phase 3/4 functions, the leakage report and the tenancy suite keep '
  'working after the rename. New code should read inventory_items directly.';

-- ---------------------------------------------------------------------------
-- 5. The ledger covers four types now
-- ---------------------------------------------------------------------------
alter table public.stock_movements
  -- Denormalized alongside color_code, which is no longer unique on its own:
  -- "RED-01" is now potentially a thread AND a tilla, and the leakage report
  -- groups by colour.
  add column if not exists item_type text not null default 'thread';

alter table public.stock_movements drop constraint if exists stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in (
    'opening',
    'grn',
    'issue',
    'audit_variance',
    -- Stock added by hand in the Inventory tab, with no PO behind it.
    'manual_add',
    -- Material coming back from the floor when a Floor Manager hands over.
    'handover_return'
  ));

alter table public.stock_movements drop constraint if exists stock_movements_ref_type_check;
alter table public.stock_movements add constraint stock_movements_ref_type_check
  check (ref_type in ('grn','material_issue','stock_audit','opening','manual','fm_handover'));

alter table public.stock_movements drop constraint if exists stock_movements_sign_chk;
alter table public.stock_movements add constraint stock_movements_sign_chk
  check (
       (movement_type = 'grn'             and quantity_meters > 0)
    or (movement_type = 'issue'           and quantity_meters < 0)
    or (movement_type = 'opening'         and quantity_meters >= 0)
    or (movement_type = 'manual_add'      and quantity_meters > 0)
    -- A leftover of exactly 0 is a real, meaningful answer ("nothing came
    -- back"), and the handover must still record that it was asked.
    or (movement_type = 'handover_return' and quantity_meters >= 0)
    or  movement_type = 'audit_variance'
  );

update public.stock_movements sm
   set item_type = ii.item_type
  from public.inventory_items ii
 where ii.id = sm.thread_stock_id
   and sm.item_type is distinct from ii.item_type;

-- ---------------------------------------------------------------------------
-- 5a. Where each row's stock came from
--
-- DERIVED, not assigned. The obvious version of this was
--
--     update inventory_items set source = 'po' where source = 'manual';
--
-- which is correct exactly once. Re-run this file after a store manager has
-- added stock by hand — and re-running is the normal way these get applied — and
-- it silently relabels all their manual stock as PO. Every row's badge would
-- then be wrong with nothing to notice it by.
--
-- A row is manual iff the ledger contains a manual_add for it. That is a fact
-- about the data rather than a guess about when this file ran, so it gives the
-- same answer every time.
-- ---------------------------------------------------------------------------
update public.inventory_items ii
   set source = case
         when exists (
           select 1 from public.stock_movements sm
            where sm.thread_stock_id = ii.id and sm.movement_type = 'manual_add')
         then 'manual' else 'po' end
 where ii.source is distinct from case
         when exists (
           select 1 from public.stock_movements sm
            where sm.thread_stock_id = ii.id and sm.movement_type = 'manual_add')
         then 'manual' else 'po' end;

-- ---------------------------------------------------------------------------
-- 6. ONE writer for the ledger, for all four types
--
-- `log_stock_movement(color_code, ...)` could only ever address thread: colour
-- alone no longer identifies an item. This is the same function keyed by item
-- id instead, and it keeps the auto-reorder that 0046 appended — reorder levels
-- are per item, so tilla and sequin get it for free.
--
-- log_stock_movement is NOT duplicated below; it is rewritten to resolve the
-- thread row and delegate here, so there is still exactly one statement in this
-- schema that writes stock_movements.
-- ---------------------------------------------------------------------------
create or replace function public.log_inventory_movement(
  p_item_id       uuid,
  p_quantity      numeric,      -- signed
  p_movement_type text,
  p_ref_type      text default null,
  p_ref_id        uuid default null,
  p_note          text default null
)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_item    public.inventory_items;
  v_balance numeric(14,2);
  v_po_id   uuid;
  v_po_code text;
  v_prefix  text;
  v_num     bigint;
  v_qty     numeric(14,2);
begin
  if v_factory is null then
    raise exception 'Your profile has no factory.' using errcode = '42501';
  end if;

  select * into v_item
    from public.inventory_items
   where id = p_item_id and factory_id = v_factory
   for update;

  -- SECURITY DEFINER bypasses RLS, so the factory check above is the tenant
  -- boundary. Report a miss as not-found either way: whether the row belongs to
  -- another factory or does not exist is not this caller's business.
  if not found then
    perform public.raise_not_found('Inventory item not found.');
  end if;

  v_balance := v_item.quantity + p_quantity;

  if v_balance < 0 then
    raise exception 'Not enough % in stock: % % available, % requested.',
      v_item.color_code, v_item.quantity, v_item.unit, abs(p_quantity)
      using errcode = '22023';
  end if;

  update public.inventory_items
     set quantity = v_balance, updated_at = now()
   where id = v_item.id;

  insert into public.stock_movements
    (factory_id, thread_stock_id, color_code, item_type, movement_type,
     quantity_meters, balance_after, actor_user_id, ref_type, ref_id, note)
  values
    (v_factory, v_item.id, v_item.color_code, v_item.item_type, p_movement_type,
     p_quantity, v_balance, auth.uid(), p_ref_type, p_ref_id, p_note);

  -- Automatic reorder (0046). Deduped against an already-open auto PO for this
  -- colour so a run of further decrements below the threshold does not raise a
  -- new PO on every movement.
  if v_item.reorder_threshold is not null and v_balance < v_item.reorder_threshold then
    if not exists (
      select 1
        from public.purchase_orders po
        join public.po_items pi on pi.purchase_order_id = po.id
       where po.factory_id = v_factory
         and pi.color_code = v_item.color_code
         and po.auto_created
         and po.status not in ('received', 'cancelled')
    ) then
      select code_prefix into v_prefix from public.factories where id = v_factory;
      v_num := public.next_po_number(v_factory);
      v_po_code := 'PO-' || v_prefix || '-' || lpad(v_num::text, 5, '0');
      v_qty := coalesce(v_item.reorder_quantity, v_item.reorder_threshold);

      insert into public.purchase_orders
        (factory_id, po_code, order_id, status, auto_created, origin)
      values (v_factory, v_po_code, null, 'auto_generated', true, 'auto_shortfall')
      returning id into v_po_id;

      insert into public.po_items
        (factory_id, purchase_order_id, color_code, quantity_meters, inventory_item_id)
      values (v_factory, v_po_id, v_item.color_code, v_qty, v_item.id);
    end if;
  end if;

  return v_balance;
end $$;

grant execute on function public.log_inventory_movement(uuid, numeric, text, text, uuid, text)
  to authenticated;

/**
 * The thread-only entry point, unchanged in signature so every Phase 3/4 caller
 * keeps working. It now only resolves the row and hands off, which is what stops
 * the two paths from ever disagreeing about how a movement is recorded.
 */
create or replace function public.log_stock_movement(
  p_color_code    text,
  p_quantity      numeric,
  p_movement_type text,
  p_ref_type      text default null,
  p_ref_id        uuid default null,
  p_note          text default null
)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_id      uuid;
begin
  if v_factory is null then
    raise exception 'Your profile has no factory.' using errcode = '42501';
  end if;
  if coalesce(trim(p_color_code), '') = '' then
    raise exception 'A colour code is required.' using errcode = '22023';
  end if;

  select id into v_id
    from public.inventory_items
   where factory_id = v_factory and item_type = 'thread' and color_code = p_color_code;

  -- First movement for a colour creates the row, exactly as before.
  if v_id is null then
    insert into public.inventory_items
      (factory_id, item_type, color_code, quantity, unit, source)
    values (v_factory, 'thread', p_color_code, 0, public.inventory_unit('thread'), 'po')
    returning id into v_id;
  end if;

  return public.log_inventory_movement(
    v_id, p_quantity, p_movement_type, p_ref_type, p_ref_id, p_note);
end $$;

grant execute on function public.log_stock_movement(text, numeric, text, text, uuid, text)
  to authenticated;
