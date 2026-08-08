-- =============================================================================
-- Factory ERP — a handover may only happen once the floor's work is done.
--
-- THE GAP
-- -------
-- `fm_submit_handover` (0071) checks the order belongs to the factory, that it
-- has not already been handed over, and that no line returns more than was
-- issued. It does NOT check that the order is finished.
--
-- `fm_handover_queue` only ever OFFERS finished orders, so the app cannot reach
-- the bad case by tapping — which is exactly the shape of gap this project's
-- standing rule is about: tenant and module rules "must be enforced through
-- Supabase Row Level Security policies, not just in the app's UI". A queue that
-- filters is a UI guard. Anyone calling the RPC directly could hand back
-- material for an order still in production, crediting cones into store stock
-- that are physically still on a machine, mid-job. The balance would be wrong
-- and the ledger would look perfectly consistent while being wrong.
--
-- WHICH STATUSES COUNT AS DONE
-- ----------------------------
-- Not 'completed' alone. The floor's work ends at final QA; the statuses after
-- that are about invoicing, and leftover cones sit on the bench throughout.
-- Waiting for an invoice before letting them be counted back would leave real
-- stock unrecorded for days, which is the same leakage in the other direction.
--
-- So: awaiting_final_qa, ready_for_delivery, completed.
--
-- `fm_handover_queue` is widened to match in the same migration. A guard and a
-- queue that disagree is how you get a button that is offered and then refuses.
-- =============================================================================

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

  -- The check this migration exists for.
  if v_order.status not in ('awaiting_final_qa','ready_for_delivery','completed') then
    raise exception
      'Material can only be handed back once the floor is finished with the order (status: %).',
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
-- The queue, widened to the same three statuses so the offer and the guard
-- agree. 0071 listed only ready_for_delivery and completed.
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
     and o.status in ('awaiting_final_qa','ready_for_delivery','completed')
     and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
     and not exists (select 1 from public.fm_handovers h where h.order_id = o.id)
   order by o.updated_at desc
$$;

grant execute on function public.fm_handover_queue() to authenticated;
