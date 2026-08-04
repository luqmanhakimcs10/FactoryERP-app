-- =============================================================================
-- Factory ERP — fix responsible_id attribution in qa_collection_damage.
--
-- `mark_stage_damage` (0045) already fixed this exact defect for the Stage 9
-- loop: `qa_collection_damage` (0020, Collection QA / Phase 6) still hardcodes
-- responsible_id to null on every worker damage record, which means payroll can
-- never actually attribute the deduction to anyone. This ports the same
-- resolution — the worker on the open shift for the order's assigned machine —
-- into the older call site. Signature and grant are unchanged.
-- =============================================================================

create or replace function public.qa_collection_damage(
  p_repeat_id   uuid,
  p_damage_type text,
  p_photo_url   text default null,
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.repeats;
  sh public.sheets;
  st public.order_stages;
  v_order public.orders;
  v_responsible_id uuid;
  v_damage_id uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','floor_manager','company_admin']);

  select * into r from public.repeats where id = p_repeat_id and factory_id = public.current_factory_id();
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select * into sh from public.sheets where id = r.sheet_id;
  select * into v_order from public.orders where id = sh.order_id;

  select st_sub.* into st
  from public.repeat_stage_history rsh
  join public.order_stages st_sub on st_sub.id = rsh.order_stage_id
  where rsh.repeat_id = p_repeat_id
  order by rsh.created_at desc
  limit 1;

  select s.worker_id into v_responsible_id
    from public.shifts s
   where s.machine_id = v_order.assigned_machine_id and s.status = 'open'
   limit 1;

  -- Create worker damage record if not already recorded
  insert into public.damage_records (
    factory_id, order_id, sheet_id, repeat_id, stage_type,
    damage_type, responsible_type, responsible_id, photo_url, note, reported_by
  ) values (
    public.current_factory_id(), sh.order_id, r.sheet_id, p_repeat_id,
    coalesce(st.stage_type, 'embroidery'), p_damage_type, 'worker', v_responsible_id,
    p_photo_url, p_note, auth.uid()
  )
  returning id into v_damage_id;

  -- Flag repeat as damaged
  update public.repeats
     set current_status = 'damaged', updated_at = now()
   where id = p_repeat_id;

  insert into public.repeat_stage_history (
    factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note
  ) values (
    public.current_factory_id(), p_repeat_id, st.id, 'damaged', auth.uid(), p_photo_url, p_note
  );

  return jsonb_build_object('repeat_id', p_repeat_id, 'damage_id', v_damage_id, 'responsible_id', v_responsible_id);
end $$;

grant execute on function public.qa_collection_damage(uuid,text,text,text) to authenticated;
