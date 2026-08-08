-- =============================================================================
-- Factory ERP — the two shortfall outcomes, machine mounting, and the Floor
-- Manager's handover back to the store.
--
-- WHAT CHANGES IN submit_order
-- ----------------------------
-- The check itself is untouched: same requirement model, same colour-by-colour
-- comparison, same two branches. What changes is that the SUFFICIENT branch is
-- no longer silent. It used to move the order to cloth inspection and tell
-- nobody, which is precisely the gap the brief describes — the floor had no way
-- to know material was already sitting in the store. It now raises the automatic
-- request as well.
--
-- The shortfall branch only gains `origin = 'auto_shortfall'`. The quantity was
-- already exactly the missing amount and stays that way.
-- =============================================================================

create or replace function public.submit_order(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order     public.orders;
  v_factory   uuid := public.current_factory_id();
  v_short     jsonb := '[]'::jsonb;
  v_po_id     uuid;
  v_po_code   text;
  v_prefix    text;
  v_num       bigint;
  r           record;
  v_has_short boolean := false;
  v_request   uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['company_admin','order_taker']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'draft' then
    raise exception 'This order has already been submitted.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sheets where order_id = p_order_id) then
    raise exception 'An order needs at least one sheet before submission.' using errcode = '22023';
  end if;

  -- Compare requirement against stock, colour by colour. `thread_stock` is now a
  -- view over inventory_items filtered to thread, so this reads the same rows it
  -- always did without knowing the table moved.
  for r in
    select req.color_code,
           req.required_meters,
           coalesce(ts.quantity_meters, 0) as available_meters
    from public.order_thread_requirements(p_order_id) req
    left join public.thread_stock ts
           on ts.factory_id = v_factory and ts.color_code = req.color_code
    order by req.color_code
  loop
    if r.required_meters > r.available_meters then
      v_has_short := true;
      v_short := v_short || jsonb_build_object(
        'color_code', r.color_code,
        'required_meters', r.required_meters,
        'available_meters', r.available_meters,
        'shortfall_meters', (r.required_meters - r.available_meters)
      );
    end if;
  end loop;

  if v_has_short then
    select code_prefix into v_prefix from public.factories where id = v_factory;
    v_num := public.next_po_number(v_factory);
    v_po_code := 'PO-' || v_prefix || '-' || lpad(v_num::text, 5, '0');

    insert into public.purchase_orders
      (factory_id, po_code, order_id, status, auto_created, origin)
    values (v_factory, v_po_code, p_order_id, 'auto_generated', true, 'auto_shortfall')
    returning id into v_po_id;

    -- Exactly the shortfall, not the full requirement: the stock already held
    -- must not be bought twice.
    insert into public.po_items (factory_id, purchase_order_id, color_code, quantity_meters)
    select v_factory, v_po_id, x->>'color_code', (x->>'shortfall_meters')::numeric
    from jsonb_array_elements(v_short) x;

    update public.orders
       set status = 'awaiting_procurement', submitted_at = now()
     where id = p_order_id;
  else
    -- Everything is in stock. Tell the floor rather than leaving them to find
    -- out: this is the Requests-tab entry the brief asks for, NOT a PO.
    v_request := public.raise_auto_material_request(p_order_id);

    update public.orders
       set status = 'awaiting_cloth_inspection', submitted_at = now()
     where id = p_order_id;
  end if;

  return jsonb_build_object(
    'order_id', p_order_id,
    'status', case when v_has_short then 'awaiting_procurement' else 'awaiting_cloth_inspection' end,
    'shortfalls', v_short,
    'purchase_order_id', v_po_id,
    'po_code', v_po_code,
    'material_request_id', v_request
  );
end $$;

grant execute on function public.submit_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Issuing material also mounts it on the machine
--
-- The brief wants mounting "driven by material issue against that machine's
-- active job card" — so it happens here, in the same transaction as the issue,
-- rather than as a separate action someone has to remember.
-- ---------------------------------------------------------------------------
create or replace function public.sm_issue_materials(
  p_job_card_id uuid,
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_card    public.job_cards;
  v_issue   public.material_issues;
  r         record;
  v_lines   int := 0;
  v_total   numeric := 0;
  v_item_id uuid;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);

  select * into v_card from public.job_cards where id = p_job_card_id;
  if not found or v_card.factory_id is distinct from v_factory then
    perform public.raise_not_found('Job card not found.');
  end if;
  if v_card.status <> 'confirmed' then
    raise exception 'Materials can only be issued against a confirmed job card (status: %).', v_card.status
      using errcode = '22023';
  end if;
  if exists (select 1 from public.material_issues where job_card_id = p_job_card_id) then
    raise exception 'Materials have already been issued for this job card.' using errcode = '22023';
  end if;

  insert into public.material_issues
    (factory_id, issue_code, job_card_id, order_id, issued_by, note)
  values
    (v_factory,
     public.make_code(v_factory, 'ISS', public.next_counter(v_factory, 'issue_seq')),
     p_job_card_id, v_card.order_id, auth.uid(), p_note)
  returning * into v_issue;

  for r in select * from public.order_thread_requirements(v_card.order_id)
  loop
    insert into public.material_issue_items
      (factory_id, material_issue_id, color_code, required_meters, issued_meters)
    values (v_factory, v_issue.id, r.color_code, r.required_meters, r.required_meters);

    perform public.log_stock_movement(
      r.color_code, -r.required_meters, 'issue', 'material_issue', v_issue.id,
      'Issued for job card on order ' ||
        coalesce((select order_code from public.orders where id = v_card.order_id), '?')
    );

    -- Mount it on the job card's machine, if one is assigned. Not an error when
    -- none is: machine assignment happens later in the floor's own flow, and
    -- refusing to issue material over it would block real work for a record
    -- that is only informational.
    if v_card.assigned_machine_id is not null then
      select id into v_item_id
        from public.inventory_items
       where factory_id = v_factory and item_type = 'thread' and color_code = r.color_code;

      if v_item_id is not null then
        insert into public.machine_mounted_items
          (factory_id, machine_id, inventory_item_id, job_card_id, quantity, mounted_by)
        values
          (v_factory, v_card.assigned_machine_id, v_item_id, p_job_card_id,
           r.required_meters, auth.uid())
        on conflict (machine_id, inventory_item_id) where unmounted_at is null
        do update set quantity    = machine_mounted_items.quantity + excluded.quantity,
                      job_card_id = excluded.job_card_id;
      end if;
    end if;

    v_lines := v_lines + 1;
    v_total := v_total + r.required_meters;
  end loop;

  if v_lines = 0 then
    raise exception 'This job card has no thread requirement to issue.' using errcode = '22023';
  end if;

  -- Move the request on, so Tab 4 shows a truthful status rather than leaving
  -- every issued request looking permanently outstanding.
  update public.material_requests
     set status = 'issued', material_issue_id = v_issue.id
   where job_card_id = p_job_card_id and status = 'pending';

  return jsonb_build_object(
    'material_issue_id', v_issue.id,
    'issue_code', v_issue.issue_code,
    'lines', v_lines,
    'total_meters', v_total
  );
end $$;

grant execute on function public.sm_issue_materials(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Acceptance closes the request
-- ---------------------------------------------------------------------------
create or replace function public.fm_accept_inventory(
  p_material_issue_id uuid,
  p_photo_url          text
)
returns public.material_issues
language plpgsql security definer set search_path = public as $$
declare
  v_issue public.material_issues;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the received materials is required.' using errcode = '22023';
  end if;

  select * into v_issue from public.material_issues where id = p_material_issue_id;
  if not found or v_issue.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Material issue not found.');
  end if;
  if v_issue.accepted_at is not null then
    raise exception 'This material issue has already been accepted.' using errcode = '22023';
  end if;

  update public.material_issues
     set accepted_by = auth.uid(), accepted_at = now(), accepted_photo_url = p_photo_url
   where id = p_material_issue_id
  returning * into v_issue;

  update public.material_requests
     set status = 'completed', completed_at = now()
   where material_issue_id = p_material_issue_id and status <> 'completed';

  return v_issue;
end $$;

grant execute on function public.fm_accept_inventory(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- HANDOVER TO STORE MANAGER
-- ---------------------------------------------------------------------------

/**
 * What was issued for an order, and what is currently mounted, so the Floor
 * Manager's handover screen can list both without guessing.
 *
 * `on_machine` marks the lines the brief says must be shown SEPARATELY — still
 * mounted, not being returned. They are listed with everything else so the
 * screen can show one row per item; the flag is what puts them in their own
 * section, and what stops them being credited back into stock.
 */
create or replace function public.fm_handover_lines(p_order_id uuid)
returns table (
  inventory_item_id uuid,
  item_type         text,
  color_code        text,
  color_name        text,
  unit              text,
  issued_quantity   numeric,
  on_machine        boolean
)
language sql stable security definer set search_path = public as $$
  select ii.id, ii.item_type, ii.color_code, ii.color_name, ii.unit,
         coalesce(sum(mii.issued_meters), 0)::numeric(14,2),
         exists (
           select 1 from public.machine_mounted_items mm
            where mm.inventory_item_id = ii.id
              and mm.unmounted_at is null
              and mm.job_card_id in (select id from public.job_cards where order_id = p_order_id)
         )
    from public.material_issues mi
    join public.material_issue_items mii on mii.material_issue_id = mi.id
    join public.inventory_items ii
      on ii.factory_id = mi.factory_id
     and ii.item_type = 'thread'
     and ii.color_code = mii.color_code
   where mi.factory_id = public.current_factory_id()
     and mi.order_id = p_order_id
   group by ii.id, ii.item_type, ii.color_code, ii.color_name, ii.unit
   order by ii.color_code
$$;

grant execute on function public.fm_handover_lines(uuid) to authenticated;

/**
 * Submit the handover: log what came back and put it back into stock.
 *
 * p_items: [{ inventory_item_id, issued_quantity, leftover_quantity, on_machine }]
 *
 * Leftovers are credited through `log_inventory_movement`, so the return is a
 * signed row in the same ledger as every other stock change. Anything else would
 * make the balance stop reconciling — material would reappear in the count with
 * nothing in the history explaining where it came from.
 *
 * A line marked on_machine is recorded and NOT credited: it never physically
 * came back. Its mount stays open, which is what keeps the machine's "On
 * Machine" section correct after the order closes.
 */
create or replace function public.fm_submit_handover(
  p_order_id uuid,
  p_items    jsonb,
  p_note     text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory  uuid := public.current_factory_id();
  v_order    public.orders;
  v_handover public.fm_handovers;
  x          jsonb;
  v_item     public.inventory_items;
  v_left     numeric(14,2);
  v_issued   numeric(14,2);
  v_onmach   boolean;
  v_returned numeric(14,2) := 0;
  v_lines    int := 0;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'There is nothing to hand over.' using errcode = '22023';
  end if;
  if exists (select 1 from public.fm_handovers where order_id = p_order_id) then
    raise exception 'This order has already been handed over to the store.'
      using errcode = '22023';
  end if;

  insert into public.fm_handovers
    (factory_id, handover_code, order_id, job_card_id, handed_over_by, note)
  values
    (v_factory,
     public.make_code(v_factory, 'HO', public.next_counter(v_factory, 'handover_seq')),
     p_order_id,
     (select id from public.job_cards where order_id = p_order_id limit 1),
     auth.uid(), p_note)
  returning * into v_handover;

  for x in select * from jsonb_array_elements(p_items)
  loop
    v_item   := public.assert_my_inventory_item((x->>'inventory_item_id')::uuid);
    v_issued := coalesce((x->>'issued_quantity')::numeric, 0);
    v_left   := coalesce((x->>'leftover_quantity')::numeric, 0);
    v_onmach := coalesce((x->>'on_machine')::boolean, false);

    if v_left < 0 then
      raise exception 'A leftover cannot be negative (% for %).', v_left, v_item.color_code
        using errcode = '22023';
    end if;
    -- More came back than went out means the count is wrong, and crediting it
    -- would invent stock that never existed.
    if v_left > v_issued then
      raise exception 'More % came back (%) than was issued (%).',
        v_item.color_code, v_left, v_issued using errcode = '22023';
    end if;
    if v_onmach and v_left > 0 then
      raise exception 'A line cannot be both left on the machine and returned (%).',
        v_item.color_code using errcode = '22023';
    end if;

    insert into public.fm_handover_items
      (factory_id, fm_handover_id, inventory_item_id, issued_quantity,
       leftover_quantity, on_machine)
    values (v_factory, v_handover.id, v_item.id, v_issued, v_left, v_onmach);

    if not v_onmach then
      -- Zero is still recorded above ("nothing came back"), but writing a
      -- zero-quantity ledger row would add noise without adding information.
      if v_left > 0 then
        perform public.log_inventory_movement(
          v_item.id, v_left, 'handover_return', 'fm_handover', v_handover.id,
          'Returned from order ' || v_order.order_code);
        v_returned := v_returned + v_left;
      end if;

      -- It came off the machine, whether or not any was left.
      update public.machine_mounted_items
         set unmounted_at = now()
       where inventory_item_id = v_item.id
         and unmounted_at is null
         and job_card_id in (select id from public.job_cards where order_id = p_order_id);
    end if;

    v_lines := v_lines + 1;
  end loop;

  return jsonb_build_object(
    'handover_id', v_handover.id,
    'handover_code', v_handover.handover_code,
    'lines', v_lines,
    'returned_quantity', v_returned
  );
end $$;

grant execute on function public.fm_submit_handover(uuid, jsonb, text) to authenticated;

/**
 * Orders that are finished, had material issued, and have not been handed back.
 *
 * `ready_for_delivery` counts as finished here as well as `completed`: the
 * floor's work on the order is over at that point and the leftover cones are
 * sitting on the bench. Waiting for the invoice to be raised before letting them
 * be returned would leave real stock uncounted for days.
 */
create or replace function public.fm_handover_queue()
returns table (
  order_id     uuid,
  order_code   text,
  vendor_name  text,
  status       text,
  line_count   int,
  finished_at  timestamptz
)
language sql stable security definer set search_path = public as $$
  select o.id, o.order_code, v.name, o.status,
         (select count(distinct mii.color_code)::int
            from public.material_issues mi2
            join public.material_issue_items mii on mii.material_issue_id = mi2.id
           where mi2.order_id = o.id),
         o.updated_at
    from public.orders o
    left join public.vendors v on v.id = o.vendor_id
   where o.factory_id = public.current_factory_id()
     and o.status in ('ready_for_delivery','completed')
     and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
     and not exists (select 1 from public.fm_handovers h where h.order_id = o.id)
   order by o.updated_at desc
$$;

grant execute on function public.fm_handover_queue() to authenticated;

/** Handover history for an order — read-only, for the order detail screen. */
create or replace function public.fm_handover_detail(p_order_id uuid)
returns table (
  handover_code     text,
  handed_over_at    timestamptz,
  handed_over_by    text,
  color_code        text,
  unit              text,
  issued_quantity   numeric,
  leftover_quantity numeric,
  on_machine        boolean
)
language sql stable security definer set search_path = public as $$
  select h.handover_code, h.handed_over_at, p.display_name,
         ii.color_code, ii.unit, hi.issued_quantity, hi.leftover_quantity, hi.on_machine
    from public.fm_handovers h
    join public.fm_handover_items hi on hi.fm_handover_id = h.id
    join public.inventory_items ii on ii.id = hi.inventory_item_id
    left join public.profiles p on p.id = h.handed_over_by
   where h.factory_id = public.current_factory_id()
     and h.order_id = p_order_id
   order by ii.color_code
$$;

grant execute on function public.fm_handover_detail(uuid) to authenticated;
