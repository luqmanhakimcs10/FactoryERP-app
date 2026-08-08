-- =============================================================================
-- Factory ERP — the handover gate reads the repeats, not the order's label.
--
-- WHAT 0075 GOT WRONG
-- -------------------
-- 0075 gated the handover on `orders.status in ('awaiting_final_qa',
-- 'ready_for_delivery','completed')`. `awaiting_final_qa` is in the orders CHECK
-- constraint, so it looked like a real state. Nothing in this schema ever sets
-- it. Grepping every `update public.orders set status = ...` turns up
-- ready_for_delivery and completed and no path to awaiting_final_qa at all — it
-- is a dead value the constraint has carried since 0026.
--
-- So the real sequence is: an order sits at `in_finishing` while its repeats work
-- through the stage loop, and jumps straight to `ready_for_delivery` once final
-- QA has cleared them (0020/0029). There is no order-level status meaning "the
-- floor has finished but QA has not signed off", which is exactly the window the
-- handover belongs in — the cones come off the machine then, not after invoicing.
--
-- Driving a real order proved it: both repeats reached awaiting_final_qa and the
-- order was still `in_finishing`, so the queue stayed empty and the guard would
-- have refused a handover that should plainly be allowed.
--
-- THE GATE, DERIVED
-- -----------------
-- `repeats` is the source of truth for where work actually is — the same
-- principle that puts every transition through repeat_stage_history. So the
-- condition is about repeats: the floor is finished when NO repeat is still in a
-- stage. Not "the order says a magic word", which is a denormalised label that
-- may never be written, as this bug demonstrates.
--
-- A repeat is still with the floor while it is at any of the in-flight statuses
-- below. Everything else — awaiting_final_qa, awaiting_qa_final, completed,
-- damaged — means the floor is done with it, whatever QA and accounts do next.
--
-- `ready_for_delivery` and `completed` stay accepted as a belt-and-braces path
-- for an order whose repeats were tidied up some other way; they can only widen
-- the window, never narrow it.
-- =============================================================================

/**
 * Is the floor finished with this order?
 *
 * One definition, called by both the guard and the queue, so an order can never
 * be offered a handover that is then refused — or refused one it should be
 * offered.
 */
create or replace function public.fm_floor_is_finished(p_order_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    -- An order with no repeats has not been through production at all.
    exists (
      select 1
        from public.repeats r
        join public.sheets sh on sh.id = r.sheet_id
       where sh.order_id = p_order_id
    )
    and not exists (
      select 1
        from public.repeats r
        join public.sheets sh on sh.id = r.sheet_id
       where sh.order_id = p_order_id
         and r.current_status in (
           'coded', 'awaiting_job_card', 'ready_for_production', 'awaiting_stage',
           'in_progress', 'stage_qa', 'in_production', 'in_finishing',
           'handover_for_delivery', 'awaiting_dp_collection', 'handed_over',
           'handed_off', 'returned_to_delivery', 'awaiting_fm_collection',
           'awaiting_collection_qa'
         )
    )
$$;

grant execute on function public.fm_floor_is_finished(uuid) to authenticated;

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

  -- Derived from the repeats (see the header), not from the order's label.
  if not (v_order.status in ('ready_for_delivery','completed')
          or public.fm_floor_is_finished(p_order_id)) then
    raise exception
      'Material can only be handed back once every piece has left the floor (order is %).',
      v_order.status using errcode = '22023';
  end if;

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

-- ---------------------------------------------------------------------------
-- The queue uses the SAME predicate, so the offer and the guard cannot disagree.
-- ---------------------------------------------------------------------------
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
     and o.status not in ('cancelled')
     and (o.status in ('ready_for_delivery','completed')
          or public.fm_floor_is_finished(o.id))
     and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
     and not exists (select 1 from public.fm_handovers h where h.order_id = o.id)
   order by o.updated_at desc
$$;

grant execute on function public.fm_handover_queue() to authenticated;
