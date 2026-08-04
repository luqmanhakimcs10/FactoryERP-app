-- =============================================================================
-- Factory ERP — Repeats & Stage Tracking loop (Stage 9).
--
-- Per repeat, per stage in the order's own stage sequence:
--   awaiting_stage -> (Start stage, Floor Manager)   -> in_progress
--   in_progress    -> (Go to QA, Floor Manager)       -> stage_qa
--   stage_qa       -> (Pass QA, QA ONLY)              -> awaiting_stage (next
--                                                        stage) or, if this was
--                                                        the last configured
--                                                        stage, awaiting_final_qa
--   any stage      -> (Mark damage, QA ONLY)          -> damaged
--
-- Pass QA and Mark damage are deliberately QA-only here — the spec groups them
-- together as QA-gated for this specific loop, even though the earlier
-- Collection-QA damage function (0020) shares damage-marking with Floor
-- Manager. Floor Manager can still see this same tracking data (the read side
-- has no role restriction beyond the usual factory/module scoping); only the
-- QA actions themselves are refused for that role.
-- =============================================================================

create or replace function public.fm_start_stage(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory  uuid := public.current_factory_id();
  v_repeat   public.repeats;
  v_order_id uuid;
  v_stage_id uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  -- A record variable cannot share an INTO list with another target, so the
  -- repeat and its order_id (via the sheet) are fetched in two steps.
  select r.* into v_repeat
    from public.repeats r
   where r.id = p_repeat_id and r.factory_id = v_factory;
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  if v_repeat.current_status <> 'awaiting_stage' then
    raise exception 'This repeat is not awaiting a stage start (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  select id into v_stage_id from public.order_stages
   where order_id = v_order_id and sequence = v_repeat.current_stage_index;

  perform public.log_repeat_stage(p_repeat_id, 'in_progress', v_stage_id, null, 'Stage started');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

create or replace function public.fm_send_to_stage_qa(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory  uuid := public.current_factory_id();
  v_repeat   public.repeats;
  v_order_id uuid;
  v_stage_id uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  -- A record variable cannot share an INTO list with another target, so the
  -- repeat and its order_id (via the sheet) are fetched in two steps.
  select r.* into v_repeat
    from public.repeats r
   where r.id = p_repeat_id and r.factory_id = v_factory;
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  if v_repeat.current_status <> 'in_progress' then
    raise exception 'This repeat is not in progress on a stage (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  select id into v_stage_id from public.order_stages
   where order_id = v_order_id and sequence = v_repeat.current_stage_index;

  perform public.log_repeat_stage(p_repeat_id, 'stage_qa', v_stage_id, null, 'Sent to stage QA');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

/** QA-only. Advances to the next stage, or to awaiting_final_qa if this was the last one. */
create or replace function public.qa_pass_stage_qa(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory     uuid := public.current_factory_id();
  v_repeat      public.repeats;
  v_order_id    uuid;
  v_total       int;
  v_next_stage  uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  -- A record variable cannot share an INTO list with another target, so the
  -- repeat and its order_id (via the sheet) are fetched in two steps.
  select r.* into v_repeat
    from public.repeats r
   where r.id = p_repeat_id and r.factory_id = v_factory;
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  if v_repeat.current_status <> 'stage_qa' then
    raise exception 'This repeat is not at Stage QA (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  select count(*) into v_total from public.order_stages where order_id = v_order_id;

  if v_repeat.current_stage_index < v_total then
    update public.repeats set current_stage_index = current_stage_index + 1 where id = p_repeat_id;
    select id into v_next_stage from public.order_stages
     where order_id = v_order_id and sequence = v_repeat.current_stage_index + 1;
    perform public.log_repeat_stage(p_repeat_id, 'awaiting_stage', v_next_stage, null, 'Stage QA passed');
  else
    perform public.log_repeat_stage(p_repeat_id, 'awaiting_final_qa', null, null, 'All stages complete');
  end if;

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

/**
 * QA-only. Mirrors qa_collection_damage's (0020) damage_records insert
 * pattern, but fixes that call site's hardcoded-null responsible_id: this
 * resolves the worker from the active shift on the repeat's assigned machine,
 * so the deduction can actually be attributed in the payroll ledger.
 */
create or replace function public.mark_stage_damage(
  p_repeat_id   uuid,
  p_damage_type text,
  p_photo_url   text default null,
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory        uuid := public.current_factory_id();
  v_repeat         public.repeats;
  v_order          public.orders;
  v_stage_id       uuid;
  v_stage_type     text;
  v_responsible_id uuid;
  v_damage_id      uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  select r.* into v_repeat from public.repeats r where r.id = p_repeat_id and r.factory_id = v_factory;
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select o.* into v_order
    from public.orders o
    join public.sheets s on s.id = v_repeat.sheet_id
   where o.id = s.order_id;

  select id, stage_type into v_stage_id, v_stage_type
    from public.order_stages
   where order_id = v_order.id and sequence = greatest(v_repeat.current_stage_index, 1);

  select s.worker_id into v_responsible_id
    from public.shifts s
   where s.machine_id = v_order.assigned_machine_id and s.status = 'open'
   limit 1;

  insert into public.damage_records (
    factory_id, order_id, sheet_id, repeat_id, stage_type,
    damage_type, responsible_type, responsible_id, photo_url, note, reported_by
  ) values (
    v_factory, v_order.id, v_repeat.sheet_id, p_repeat_id,
    coalesce(v_stage_type, 'embroidery'), p_damage_type, 'worker', v_responsible_id,
    p_photo_url, p_note, auth.uid()
  ) returning id into v_damage_id;

  update public.repeats set current_status = 'damaged', updated_at = now() where id = p_repeat_id;

  insert into public.repeat_stage_history (
    factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note
  ) values (
    v_factory, p_repeat_id, v_stage_id, 'damaged', auth.uid(), p_photo_url, p_note
  );

  return jsonb_build_object('repeat_id', p_repeat_id, 'damage_id', v_damage_id, 'responsible_id', v_responsible_id);
end $$;

grant execute on function public.fm_start_stage(uuid) to authenticated;
grant execute on function public.fm_send_to_stage_qa(uuid) to authenticated;
grant execute on function public.qa_pass_stage_qa(uuid) to authenticated;
grant execute on function public.mark_stage_damage(uuid, text, text, text) to authenticated;
