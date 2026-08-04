-- =============================================================================
-- Factory ERP — "Start production" (Stage 8).
--
-- The explicit hand-off from machine assignment (0041) into the Repeats &
-- Stage Tracking loop (0043/0045). Guards both preconditions the button is
-- meant to enforce: a machine must be assigned, and that machine must
-- currently have an open shift (Stage 6 + Stage 7 both done).
-- =============================================================================

create or replace function public.fm_start_production(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_first uuid;
  r       record;
  v_moved int := 0;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'machine_selection_pending' then
    raise exception 'This order is not awaiting production start (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if v_order.assigned_machine_id is null then
    raise exception 'Assign a machine before starting production.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.shifts
     where machine_id = v_order.assigned_machine_id and status = 'open'
  ) then
    raise exception 'The assigned machine does not currently have an active shift.' using errcode = '22023';
  end if;

  update public.orders set status = 'in_production' where id = p_order_id;

  select id into v_first from public.order_stages
   where order_id = p_order_id order by sequence limit 1;

  for r in
    select rp.id from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where s.order_id = p_order_id
       and rp.current_status = 'ready_for_production'
  loop
    perform public.log_repeat_stage(r.id, 'awaiting_stage', v_first, null, 'Production started');
    update public.repeats set current_stage_index = 1 where id = r.id;
    v_moved := v_moved + 1;
  end loop;

  return jsonb_build_object('order_id', p_order_id, 'status', 'in_production', 'repeats_advanced', v_moved);
end $$;

grant execute on function public.fm_start_production(uuid) to authenticated;
