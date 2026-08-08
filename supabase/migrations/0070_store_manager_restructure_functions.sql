-- =============================================================================
-- Factory ERP — Store Manager restructure: PO, Inventory and Requests.
--
-- Everything here is SECURITY DEFINER and therefore bypasses RLS, so every
-- function re-checks `factory_id = current_factory_id()` itself. That is the
-- tenant boundary for this file; the policies in 0069 only cover direct reads.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create or replace function public.assert_my_inventory_item(p_item_id uuid)
returns public.inventory_items
language plpgsql stable security definer set search_path = public as $$
declare v public.inventory_items;
begin
  select * into v from public.inventory_items where id = p_item_id;
  if not found or v.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Inventory item not found.');
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- TAB 2 — INVENTORY
-- ---------------------------------------------------------------------------

/**
 * The Inventory tab's list: all four types, newest movement first within type.
 *
 * `display_quantity` is the number to show and `unit` how to label it, so the
 * screen never has to know that bobbin means metres and thread means cones.
 */
create or replace function public.inventory_list(p_item_type text default null)
returns table (
  id            uuid,
  item_type     text,
  color_code    text,
  color_name    text,
  quantity      numeric,
  unit          text,
  source        text,
  size_mm       int,
  sequin_type   text,
  cd_count      numeric,
  yards_per_cd  numeric,
  reorder_threshold numeric,
  updated_at    timestamptz
)
language sql stable security definer set search_path = public as $$
  select ii.id, ii.item_type, ii.color_code, ii.color_name, ii.quantity, ii.unit,
         ii.source, ii.size_mm, ii.sequin_type, ii.cd_count, ii.yards_per_cd,
         ii.reorder_threshold, ii.updated_at
    from public.inventory_items ii
   where ii.factory_id = public.current_factory_id()
     and (p_item_type is null or ii.item_type = p_item_type)
   order by ii.item_type, ii.color_code
$$;

grant execute on function public.inventory_list(text) to authenticated;

/**
 * Add stock by hand, for any of the four types.
 *
 * Sequin may be entered EITHER as a direct count OR as CD rolls. When CDs are
 * given the count is computed here with `sequin_count_from_cds`, never taken
 * from the client: the brief's whole reason for the formula is that a
 * hand-guessed count is what it replaces, and a client-side number would just be
 * a guess that travelled further.
 *
 * Adding to an item that already exists tops it up rather than failing, because
 * "add 5 more cones of red" is the common case and making the user find and edit
 * the existing row instead would be a worse screen.
 */
create or replace function public.sm_add_inventory(
  p_item_type    text,
  p_color_code   text,
  p_quantity     numeric default null,   -- direct amount (all types)
  p_color_name   text default null,
  p_size_mm      int  default null,      -- sequin only
  p_sequin_type  text default null,      -- sequin only
  p_cd_count     numeric default null,   -- sequin only, alternative to p_quantity
  p_yards_per_cd numeric default 90,
  p_note         text default null
)
returns public.inventory_items
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_item    public.inventory_items;
  v_qty     numeric(14,2);
  v_id      uuid;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);

  if v_factory is null then
    raise exception 'Your profile has no factory.' using errcode = '42501';
  end if;
  if p_item_type not in ('thread','tilla','sequin','bobbin') then
    raise exception 'Unknown item type "%".', p_item_type using errcode = '22023';
  end if;
  if coalesce(trim(p_color_code), '') = '' then
    raise exception 'A colour is required.' using errcode = '22023';
  end if;

  if p_item_type = 'sequin' then
    if p_size_mm is null or p_size_mm not in (3,5,9) then
      raise exception 'Sequin size must be 3, 5 or 9 mm.' using errcode = '22023';
    end if;
    if p_cd_count is not null then
      v_qty := public.sequin_count_from_cds(p_cd_count, p_size_mm, p_yards_per_cd);
    else
      v_qty := p_quantity;
    end if;
  else
    if p_size_mm is not null or p_sequin_type is not null or p_cd_count is not null then
      raise exception 'Size, type and CD count apply to sequins only.' using errcode = '22023';
    end if;
    v_qty := p_quantity;
  end if;

  if v_qty is null or v_qty <= 0 then
    raise exception 'Enter how much is being added.' using errcode = '22023';
  end if;

  -- Match the identity the unique index uses, so this finds exactly the row a
  -- second insert would collide with.
  select id into v_id
    from public.inventory_items
   where factory_id = v_factory
     and item_type = p_item_type
     and color_code = p_color_code
     and coalesce(size_mm, -1) = coalesce(p_size_mm, -1)
     and lower(coalesce(sequin_type, '')) = lower(coalesce(p_sequin_type, ''));

  if v_id is null then
    insert into public.inventory_items
      (factory_id, item_type, color_code, color_name, quantity, unit, source,
       size_mm, sequin_type, cd_count, yards_per_cd)
    values
      (v_factory, p_item_type, p_color_code, p_color_name, 0,
       public.inventory_unit(p_item_type), 'manual',
       p_size_mm, p_sequin_type,
       case when p_item_type = 'sequin' then p_cd_count end,
       case when p_item_type = 'sequin' and p_cd_count is not null then p_yards_per_cd end)
    returning id into v_id;
  end if;

  perform public.log_inventory_movement(
    v_id, v_qty, 'manual_add', 'manual', null,
    coalesce(p_note,
      case when p_cd_count is not null
           then p_cd_count || ' CD(s) at ' || p_size_mm || ' mm'
           else 'Added by hand' end));

  select * into v_item from public.inventory_items where id = v_id;
  return v_item;
end $$;

grant execute on function public.sm_add_inventory(text, text, numeric, text, int, text, numeric, numeric, text)
  to authenticated;

/**
 * What is mounted on one machine right now. Drives the "On Machine" section on
 * the machine detail screen.
 */
create or replace function public.machine_mounted_list(p_machine_id uuid)
returns table (
  id            uuid,
  item_type     text,
  color_code    text,
  color_name    text,
  quantity      numeric,
  unit          text,
  order_code    text,
  mounted_at    timestamptz
)
language sql stable security definer set search_path = public as $$
  select mm.id, ii.item_type, ii.color_code, ii.color_name, mm.quantity, ii.unit,
         o.order_code, mm.mounted_at
    from public.machine_mounted_items mm
    join public.inventory_items ii on ii.id = mm.inventory_item_id
    left join public.job_cards jc on jc.id = mm.job_card_id
    left join public.orders o on o.id = jc.order_id
   where mm.factory_id = public.current_factory_id()
     and mm.machine_id = p_machine_id
     and mm.unmounted_at is null
   order by ii.item_type, ii.color_code
$$;

grant execute on function public.machine_mounted_list(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- TAB 1 — PO
-- ---------------------------------------------------------------------------

/**
 * Both kinds of PO in one list, with `origin` visible, for the PO tab.
 *
 * Deliberately not filtered to one status: the tab is the store manager's view
 * of procurement as a whole, and hiding executed POs would hide exactly the ones
 * about to arrive at their door.
 */
create or replace function public.sm_po_list()
returns table (
  id             uuid,
  po_code        text,
  status         text,
  origin         text,
  supplier_name  text,
  order_code     text,
  assigned_to    text,
  line_count     int,
  total_quantity numeric,
  created_at     timestamptz
)
language sql stable security definer set search_path = public as $$
  select po.id, po.po_code, po.status, po.origin,
         s.name, o.order_code, p.display_name,
         (select count(*)::int from public.po_items pi where pi.purchase_order_id = po.id),
         (select coalesce(sum(pi.quantity_meters), 0) from public.po_items pi
           where pi.purchase_order_id = po.id),
         po.created_at
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    left join public.orders    o on o.id = po.order_id
    left join public.profiles  p on p.id = po.assigned_procurement_user_id
   where po.factory_id = public.current_factory_id()
   order by po.created_at desc
$$;

grant execute on function public.sm_po_list() to authenticated;

/** The procurement people a manual PO can be tagged to. */
create or replace function public.procurement_users()
returns table (id uuid, display_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name
    from public.profiles p
   where p.factory_id = public.current_factory_id()
     and p.role = 'procurement'
     and p.is_active
   order by p.display_name
$$;

grant execute on function public.procurement_users() to authenticated;

/**
 * Store manager raises a PO by hand and tags the procurement person who will go
 * and execute it.
 *
 * p_items: [{ inventory_item_id?, color_code?, description?, quantity }]
 *
 * The assignee is required. An untagged manual PO would sit in the shared queue
 * with no one accountable for it, which is the situation the brief's "tag a
 * specific Procurement person" exists to prevent.
 */
create or replace function public.sm_create_manual_po(
  p_items       jsonb,
  p_assigned_to uuid,
  p_supplier_id uuid default null,
  p_note        text  default null
)
returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_po      public.purchase_orders;
  v_id      uuid;
  v_n       int;
  x         jsonb;
  v_item    public.inventory_items;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item to the purchase order.' using errcode = '22023';
  end if;
  if p_assigned_to is null then
    raise exception 'Choose the procurement person who will handle this.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = p_assigned_to and factory_id = v_factory and role = 'procurement' and is_active
  ) then
    raise exception 'That person is not an active procurement user in this factory.'
      using errcode = '22023';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers where id = p_supplier_id and factory_id = v_factory
  ) then
    perform public.raise_not_found('Supplier not found.');
  end if;

  insert into public.purchase_orders
    (factory_id, po_code, order_id, supplier_id, status, auto_created, origin,
     assigned_procurement_user_id, created_by, notes)
  values
    (v_factory, public.make_code(v_factory, 'PO', public.next_counter(v_factory, 'po_seq')),
     null, p_supplier_id, 'draft', false, 'manual', p_assigned_to, auth.uid(), p_note)
  returning * into v_po;

  v_n := 0;
  for x in select * from jsonb_array_elements(p_items)
  loop
    v_n := v_n + 1;
    if coalesce((x->>'quantity')::numeric, 0) <= 0 then
      raise exception 'Line % needs a quantity greater than zero.', v_n using errcode = '22023';
    end if;

    if x ? 'inventory_item_id' and nullif(x->>'inventory_item_id','') is not null then
      v_item := public.assert_my_inventory_item((x->>'inventory_item_id')::uuid);
      insert into public.po_items
        (factory_id, purchase_order_id, inventory_item_id, color_code, description, quantity_meters)
      values
        (v_factory, v_po.id, v_item.id, v_item.color_code,
         initcap(v_item.item_type) || ' - ' || v_item.color_code
           || coalesce(' (' || v_item.size_mm || ' mm)', ''),
         (x->>'quantity')::numeric);
    else
      if coalesce(trim(x->>'description'), '') = '' and nullif(x->>'color_code','') is null then
        raise exception 'Line % needs an item or a description.', v_n using errcode = '22023';
      end if;
      insert into public.po_items
        (factory_id, purchase_order_id, color_code, description, quantity_meters)
      values
        (v_factory, v_po.id, nullif(x->>'color_code',''), nullif(trim(x->>'description'),''),
         (x->>'quantity')::numeric);
    end if;
  end loop;

  return v_po;
end $$;

grant execute on function public.sm_create_manual_po(jsonb, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- TAB 4 — REQUESTS
-- ---------------------------------------------------------------------------

/**
 * The full request history: both origins, with status.
 *
 * Not filtered to open requests — the brief asks for a history, and "what did we
 * ask for last week and did it arrive" is the question this tab answers.
 */
create or replace function public.material_request_history()
returns table (
  id           uuid,
  request_code text,
  order_id     uuid,
  order_code   text,
  vendor_name  text,
  job_card_id  uuid,
  origin       text,
  directed_to  text,
  status       text,
  requested_at timestamptz,
  completed_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select mr.id, mr.request_code, mr.order_id, o.order_code, v.name, mr.job_card_id,
         mr.origin, mr.directed_to, mr.status, mr.requested_at, mr.completed_at
    from public.material_requests mr
    join public.orders o on o.id = mr.order_id
    left join public.vendors v on v.id = o.vendor_id
   where mr.factory_id = public.current_factory_id()
   order by mr.requested_at desc
$$;

grant execute on function public.material_request_history() to authenticated;

/**
 * Raise the automatic "stock is already here" request.
 *
 * Called from submit_order when the inventory check finds no shortfall. Silent
 * no-op if one already exists so a resubmitted order cannot raise two.
 */
create or replace function public.raise_auto_material_request(p_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_id      uuid;
begin
  select id into v_id from public.material_requests
   where order_id = p_order_id and origin = 'auto_stock_ready';
  if v_id is not null then
    return v_id;
  end if;

  insert into public.material_requests
    (factory_id, request_code, order_id, job_card_id, origin, directed_to,
     status, note, requested_by)
  values
    (v_factory,
     public.make_code(v_factory, 'MR', public.next_counter(v_factory, 'request_seq')),
     p_order_id, null, 'auto_stock_ready', 'floor_manager', 'pending',
     'Material ready — everything this order needs is in stock', auth.uid())
  returning id into v_id;

  return v_id;
end $$;

/**
 * Floor Manager acknowledges an auto request ("yes, I can collect").
 *
 * ASSUMPTION, flagged: the brief says this request tells the Floor Manager
 * "Material ready, you can accept" but does not say what acceptance does to
 * stock. Nothing here moves stock — the existing material-issue flow is still
 * the only thing that deducts it. This marks the notice as dealt with, so the
 * Requests tab can show it completed rather than leaving it open forever.
 */
create or replace function public.fm_acknowledge_material_request(p_request_id uuid)
returns public.material_requests
language plpgsql security definer set search_path = public as $$
declare v public.material_requests;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager','company_admin']);

  select * into v from public.material_requests where id = p_request_id;
  if not found or v.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Request not found.');
  end if;
  if v.origin <> 'auto_stock_ready' then
    raise exception 'Only an automatic "material ready" notice is acknowledged this way.'
      using errcode = '22023';
  end if;
  if v.status <> 'pending' then
    raise exception 'This request has already been dealt with.' using errcode = '22023';
  end if;

  update public.material_requests
     set status = 'completed', completed_at = now()
   where id = p_request_id
  returning * into v;

  return v;
end $$;

grant execute on function public.fm_acknowledge_material_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Keeping the request row in step with the two existing flows
--
-- `fm_ask_for_material` and `sm_issue_materials` are rewritten rather than
-- shadowed by a trigger. This schema has one business-logic trigger and it was
-- deliberately avoided elsewhere (see 0046's header); a request row appearing
-- from nowhere would be exactly the kind of action-at-a-distance that comment
-- warns about.
-- ---------------------------------------------------------------------------

create or replace function public.fm_ask_for_material(p_order_id uuid)
returns public.job_cards
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_card    public.job_cards;
  v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'There is no job card on this order.' using errcode = 'P0002';
  end if;
  if v_card.status <> 'confirmed' then
    raise exception 'The job card must be confirmed before material can be requested (status: %).', v_card.status
      using errcode = '22023';
  end if;
  if v_card.material_requested_at is not null then
    raise exception 'Material has already been requested for this job card.' using errcode = '22023';
  end if;

  update public.job_cards
     set material_requested_at = now()
   where id = v_card.id
  returning * into v_card;

  -- The history row for Tab 4, written in the same transaction as the flag it
  -- mirrors so the two can never disagree.
  insert into public.material_requests
    (factory_id, request_code, order_id, job_card_id, origin, directed_to,
     status, requested_by)
  values
    (v_factory,
     public.make_code(v_factory, 'MR', public.next_counter(v_factory, 'request_seq')),
     p_order_id, v_card.id, 'job_card', 'store_manager', 'pending', auth.uid())
  on conflict (job_card_id) where job_card_id is not null do nothing;

  return v_card;
end $$;

grant execute on function public.fm_ask_for_material(uuid) to authenticated;
