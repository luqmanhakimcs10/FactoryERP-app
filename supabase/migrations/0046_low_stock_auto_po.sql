-- =============================================================================
-- Factory ERP — Automatic low-stock PO generation (Stage 10).
--
-- `log_stock_movement()` (0013) is already the ONLY way thread_stock changes —
-- its own doc comment says so, and every stock-touching RPC in this schema
-- (`sm_opening_stock`, `sm_confirm_grn`, `sm_issue_materials`, `sm_submit_audit`)
-- routes through it. Rather than add the first business-logic trigger this
-- schema has ever had, the reorder check is appended INSIDE that function, in
-- the same transaction as the movement that crossed the threshold — matching
-- this codebase's established convention of funnelling every write for a
-- table through one function.
--
-- Fully automatic, per the confirmed decision: no manual trigger anywhere,
-- fires from an order shortfall, a GRN, an issue, an audit, or any other
-- movement — not just at order-submission time (which already had its own,
-- separate, order-specific auto-PO path in `submit_order`; this is additive).
-- =============================================================================

alter table public.thread_stock
  add column if not exists reorder_threshold numeric(14,2),
  add column if not exists reorder_quantity   numeric(14,2);

create or replace function public.log_stock_movement(
  p_color_code    text,
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
  v_stock   public.thread_stock;
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
  if coalesce(trim(p_color_code), '') = '' then
    raise exception 'A colour code is required.' using errcode = '22023';
  end if;

  select * into v_stock
    from public.thread_stock
   where factory_id = v_factory and color_code = p_color_code
   for update;

  if not found then
    insert into public.thread_stock (factory_id, color_code, quantity_meters)
    values (v_factory, p_color_code, 0)
    returning * into v_stock;
  end if;

  v_balance := v_stock.quantity_meters + p_quantity;

  -- Stock cannot go negative: issuing more than is held means the count is
  -- wrong, and silently going negative would corrupt the leakage report.
  if v_balance < 0 then
    raise exception 'Not enough % in stock: % m available, % m requested.',
      p_color_code, v_stock.quantity_meters, abs(p_quantity)
      using errcode = '22023';
  end if;

  update public.thread_stock
     set quantity_meters = v_balance, updated_at = now()
   where id = v_stock.id;

  insert into public.stock_movements
    (factory_id, thread_stock_id, color_code, movement_type, quantity_meters,
     balance_after, actor_user_id, ref_type, ref_id, note)
  values
    (v_factory, v_stock.id, p_color_code, p_movement_type, p_quantity,
     v_balance, auth.uid(), p_ref_type, p_ref_id, p_note);

  -- Automatic reorder. Deduped against an already-open auto PO for this
  -- colour, so a run of further decrements while still below threshold does
  -- not spam a new PO on every movement.
  if v_stock.reorder_threshold is not null and v_balance < v_stock.reorder_threshold then
    if not exists (
      select 1
        from public.purchase_orders po
        join public.po_items pi on pi.purchase_order_id = po.id
       where po.factory_id = v_factory
         and pi.color_code = p_color_code
         and po.auto_created
         and po.status not in ('received', 'cancelled')
    ) then
      select code_prefix into v_prefix from public.factories where id = v_factory;
      v_num := public.next_po_number(v_factory);
      v_po_code := 'PO-' || v_prefix || '-' || lpad(v_num::text, 5, '0');
      v_qty := coalesce(v_stock.reorder_quantity, v_stock.reorder_threshold);

      insert into public.purchase_orders (factory_id, po_code, order_id, status, auto_created)
      values (v_factory, v_po_code, null, 'auto_generated', true)
      returning id into v_po_id;

      insert into public.po_items (factory_id, purchase_order_id, color_code, quantity_meters)
      values (v_factory, v_po_id, p_color_code, v_qty);
    end if;
  end if;

  return v_balance;
end $$;

/** Store manager sets the reorder point per colour. Either field may be null (no auto-reorder). */
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
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager', 'company_admin']);

  if p_reorder_threshold is not null and p_reorder_threshold < 0 then
    raise exception 'Reorder threshold cannot be negative.' using errcode = '22023';
  end if;
  if p_reorder_quantity is not null and p_reorder_quantity <= 0 then
    raise exception 'Reorder quantity must be greater than zero.' using errcode = '22023';
  end if;

  insert into public.thread_stock (factory_id, color_code, quantity_meters, reorder_threshold, reorder_quantity)
  values (v_factory, p_color_code, 0, p_reorder_threshold, p_reorder_quantity)
  on conflict (factory_id, color_code) do update
    set reorder_threshold = excluded.reorder_threshold,
        reorder_quantity  = excluded.reorder_quantity,
        updated_at = now()
  returning * into v_stock;

  return v_stock;
end $$;

grant execute on function public.log_stock_movement(text, numeric, text, text, uuid, text) to authenticated;
grant execute on function public.sm_set_reorder_levels(text, numeric, numeric) to authenticated;
