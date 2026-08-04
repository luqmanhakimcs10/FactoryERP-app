-- =============================================================================
-- Factory ERP — Phase 6: Finishing transition functions & SLA alerting RPCs
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: check if caller has permission for a stage (Delivery vs Handler)
-- ---------------------------------------------------------------------------
create or replace function public.assert_stage_access(p_order_stage_id uuid)
returns public.order_stages
language plpgsql stable security definer set search_path = public as $$
declare
  st public.order_stages;
  v_role text := public.current_user_role();
begin
  select * into st from public.order_stages where id = p_order_stage_id;
  if not found or st.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Stage not found.');
  end if;

  if v_role = 'company_admin' or v_role = 'super_admin' then
    return st;
  end if;

  if st.is_outsourced then
    if v_role <> 'delivery' then
      raise exception 'Outsourced stage requires delivery_person role.' using errcode = '42501';
    end if;
  else
    if v_role <> 'delivery' and st.handler_user_id is distinct from auth.uid() then
      raise exception 'In-house stage requires assigned handler or delivery_person role.' using errcode = '42501';
    end if;
  end if;

  return st;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Handoff Queue (Delivery Person / Internal Handler)
-- ---------------------------------------------------------------------------
create or replace function public.dp_handoff_queue()
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  order_stage_id   uuid,
  stage_type       text,
  sequence         int,
  is_outsourced    boolean,
  sla_hours        int,
  partner_name     text,
  handler_name     text
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery','floor_manager','company_admin']);

  return query
  select
    r.id,
    r.repeat_code,
    o.id,
    o.order_code,
    st.id,
    st.stage_type,
    st.sequence,
    st.is_outsourced,
    st.sla_hours,
    fp.name,
    hp.display_name
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  join public.order_stages st on st.order_id = o.id
  left join public.finishing_partners fp on fp.id = st.partner_id
  left join public.profiles hp on hp.id = st.handler_user_id
  where r.factory_id = public.current_factory_id()
    and r.current_status in ('ready_for_production', 'coded')
    -- Next unexecuted stage for this repeat
    and st.sequence = (
      select coalesce(min(st_inner.sequence), 1)
      from public.order_stages st_inner
      where st_inner.order_id = o.id
        and not exists (
          select 1 from public.repeat_stage_history rsh
          where rsh.repeat_id = r.id
            and rsh.order_stage_id = st_inner.id
            and rsh.handed_off_at is not null
        )
    )
    and (
      public.current_user_role() in ('delivery', 'company_admin')
      or (not st.is_outsourced and st.handler_user_id = auth.uid())
    )
  order by o.created_at asc, st.sequence asc, r.repeat_code asc;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Confirm Handoff
-- ---------------------------------------------------------------------------
create or replace function public.dp_confirm_handoff(
  p_repeat_id      uuid,
  p_order_stage_id uuid,
  p_photo_url      text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r public.repeats;
  st public.order_stages;
  v_hist_id uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery','floor_manager','company_admin']);

  st := public.assert_stage_access(p_order_stage_id);

  select * into r from public.repeats where id = p_repeat_id and factory_id = public.current_factory_id();
  if not found then
    perform public.raise_not_found('Repeat not found.');
  end if;

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'Handoff photo is required.' using errcode = '22023';
  end if;

  -- Write history row marking start of handoff & SLA
  insert into public.repeat_stage_history (
    factory_id,
    repeat_id,
    order_stage_id,
    status,
    actor_user_id,
    handoff_photo_url,
    handed_off_at,
    partner_id
  ) values (
    public.current_factory_id(),
    p_repeat_id,
    p_order_stage_id,
    'handed_off',
    auth.uid(),
    p_photo_url,
    now(),
    st.partner_id
  )
  returning id into v_hist_id;

  -- Update repeat status
  update public.repeats
     set current_status = 'handed_off',
         updated_at = now()
   where id = p_repeat_id;

  -- Update order status to in_production / in_finishing if needed
  update public.orders
     set status = case when st.stage_type = 'embroidery' then 'in_production' else 'in_finishing' end,
         updated_at = now()
   where id = st.order_id and status in ('job_card_confirmed', 'in_production');

  return v_hist_id;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Return Queue
-- ---------------------------------------------------------------------------
create or replace function public.dp_return_queue()
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  order_stage_id   uuid,
  stage_type       text,
  sequence         int,
  is_outsourced    boolean,
  sla_hours        int,
  partner_name     text,
  handler_name     text,
  handed_off_at    timestamptz,
  is_breached      boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery','floor_manager','company_admin']);

  return query
  select
    r.id,
    r.repeat_code,
    o.id,
    o.order_code,
    st.id,
    st.stage_type,
    st.sequence,
    st.is_outsourced,
    st.sla_hours,
    fp.name,
    hp.display_name,
    rsh.handed_off_at,
    (now() > rsh.handed_off_at + (st.sla_hours || ' hours')::interval) as is_breached
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  join lateral (
    select rsh_sub.*
    from public.repeat_stage_history rsh_sub
    where rsh_sub.repeat_id = r.id
      and rsh_sub.handed_off_at is not null
      and rsh_sub.returned_at is null
    order by rsh_sub.handed_off_at desc
    limit 1
  ) rsh on true
  join public.order_stages st on st.id = rsh.order_stage_id
  left join public.finishing_partners fp on fp.id = st.partner_id
  left join public.profiles hp on hp.id = st.handler_user_id
  where r.factory_id = public.current_factory_id()
    and r.current_status = 'handed_off'
    and (
      public.current_user_role() in ('delivery', 'company_admin')
      or (not st.is_outsourced and st.handler_user_id = auth.uid())
    )
  order by is_breached desc, rsh.handed_off_at asc;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Confirm Return (Clean or Partner Damage)
-- ---------------------------------------------------------------------------
create or replace function public.dp_confirm_return(
  p_repeat_id         uuid,
  p_return_photo_url  text,
  p_has_damage        boolean default false,
  p_damage_type       text default null,
  p_damage_photo_url  text default null,
  p_damage_note       text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.repeats;
  rsh public.repeat_stage_history;
  st public.order_stages;
  v_damage_id uuid := null;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery','floor_manager','company_admin']);

  select * into r from public.repeats where id = p_repeat_id and factory_id = public.current_factory_id();
  if not found then
    perform public.raise_not_found('Repeat not found.');
  end if;

  -- Find the open handoff record
  select * into rsh
  from public.repeat_stage_history
  where repeat_id = p_repeat_id
    and handed_off_at is not null
    and returned_at is null
  order by handed_off_at desc
  limit 1;

  if not found then
    raise exception 'No open handoff found for this repeat.' using errcode = '22023';
  end if;

  st := public.assert_stage_access(rsh.order_stage_id);

  if coalesce(trim(p_return_photo_url), '') = '' then
    raise exception 'Return photo is required.' using errcode = '22023';
  end if;

  -- Close handoff history row
  update public.repeat_stage_history
     set return_photo_url = p_return_photo_url,
         returned_at = now()
   where id = rsh.id;

  -- Resolve any open SLA alert
  update public.sla_alerts
     set resolved_at = now()
   where repeat_id = p_repeat_id
     and order_stage_id = st.id
     and resolved_at is null;

  -- Handle partner damage if flagged
  if p_has_damage then
    if p_damage_type is null then
      raise exception 'Damage type is required when damage is flagged.' using errcode = '22023';
    end if;

    insert into public.damage_records (
      factory_id,
      order_id,
      sheet_id,
      repeat_id,
      stage_type,
      damage_type,
      responsible_type,
      responsible_id,
      photo_url,
      note,
      reported_by
    ) values (
      public.current_factory_id(),
      st.order_id,
      r.sheet_id,
      p_repeat_id,
      st.stage_type,
      p_damage_type,
      'partner',
      st.partner_id,
      coalesce(p_damage_photo_url, p_return_photo_url),
      p_damage_note,
      auth.uid()
    )
    returning id into v_damage_id;
  end if;

  -- Advance repeat to awaiting_collection_qa
  update public.repeats
     set current_status = 'awaiting_collection_qa',
         updated_at = now()
   where id = p_repeat_id;

  return jsonb_build_object(
    'repeat_id', p_repeat_id,
    'status', 'awaiting_collection_qa',
    'damage_id', v_damage_id
  );
end $$;

-- ---------------------------------------------------------------------------
-- 5. Collection QA Queue (QA Person & Floor Manager)
-- ---------------------------------------------------------------------------
create or replace function public.qa_collection_queue()
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  order_stage_id   uuid,
  stage_type       text,
  sequence         int,
  total_stages     int,
  has_partner_damage boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','floor_manager','company_admin']);

  return query
  select
    r.id,
    r.repeat_code,
    o.id,
    o.order_code,
    st.id,
    st.stage_type,
    st.sequence,
    (select count(*)::int from public.order_stages where order_id = o.id),
    exists (
      select 1 from public.damage_records dr
      where dr.repeat_id = r.id and dr.responsible_type = 'partner'
    )
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  join lateral (
    select rsh_sub.*
    from public.repeat_stage_history rsh_sub
    where rsh_sub.repeat_id = r.id
    order by rsh_sub.created_at desc
    limit 1
  ) rsh on true
  left join public.order_stages st on st.id = rsh.order_stage_id
  where r.factory_id = public.current_factory_id()
    and r.current_status = 'awaiting_collection_qa'
  order by o.created_at asc, r.repeat_code asc;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Collection QA Pass
-- ---------------------------------------------------------------------------
create or replace function public.qa_collection_pass(p_repeat_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.repeats;
  sh public.sheets;
  o public.orders;
  v_last_stage public.order_stages;
  v_next_stage public.order_stages;
  v_total_stages int;
  v_completed_repeats int;
  v_total_repeats int;
  v_new_status text;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','floor_manager','company_admin']);

  select * into r from public.repeats where id = p_repeat_id and factory_id = public.current_factory_id();
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select * into sh from public.sheets where id = r.sheet_id;
  select * into o from public.orders where id = sh.order_id;

  -- Find last completed stage from history
  select st.* into v_last_stage
  from public.repeat_stage_history rsh
  join public.order_stages st on st.id = rsh.order_stage_id
  where rsh.repeat_id = p_repeat_id
    and rsh.returned_at is not null
  order by rsh.returned_at desc
  limit 1;

  -- Check next stage in sequence
  select * into v_next_stage
  from public.order_stages
  where order_id = o.id
    and sequence > coalesce(v_last_stage.sequence, 0)
  order by sequence asc
  limit 1;

  if v_next_stage.id is not null then
    -- More stages remain -> ready for next handoff/production
    v_new_status := 'ready_for_production';
  else
    -- All stages done -> ready for final QA
    v_new_status := 'awaiting_final_qa';
  end if;

  update public.repeats
     set current_status = v_new_status,
         updated_at = now()
   where id = p_repeat_id;

  -- Log QA pass event
  insert into public.repeat_stage_history (
    factory_id, repeat_id, order_stage_id, status, actor_user_id, note
  ) values (
    public.current_factory_id(), p_repeat_id, v_last_stage.id, v_new_status, auth.uid(), 'Collection QA passed'
  );

  -- If all repeats for the order are in awaiting_final_qa / completed, update order status
  select count(*) into v_total_repeats from public.repeats r2 join public.sheets s2 on s2.id = r2.sheet_id where s2.order_id = o.id;
  select count(*) into v_completed_repeats from public.repeats r2 join public.sheets s2 on s2.id = r2.sheet_id where s2.order_id = o.id and r2.current_status in ('awaiting_final_qa', 'completed');

  if v_completed_repeats = v_total_repeats then
    update public.orders set status = 'ready_for_delivery', updated_at = now() where id = o.id;
  end if;

  return jsonb_build_object(
    'repeat_id', p_repeat_id,
    'next_status', v_new_status
  );
end $$;

-- ---------------------------------------------------------------------------
-- 7. Collection QA Worker Damage
-- ---------------------------------------------------------------------------
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
  v_damage_id uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','floor_manager','company_admin']);

  select * into r from public.repeats where id = p_repeat_id and factory_id = public.current_factory_id();
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select * into sh from public.sheets where id = r.sheet_id;

  select st_sub.* into st
  from public.repeat_stage_history rsh
  join public.order_stages st_sub on st_sub.id = rsh.order_stage_id
  where rsh.repeat_id = p_repeat_id
  order by rsh.created_at desc
  limit 1;

  -- Create worker damage record if not already recorded
  insert into public.damage_records (
    factory_id, order_id, sheet_id, repeat_id, stage_type,
    damage_type, responsible_type, responsible_id, photo_url, note, reported_by
  ) values (
    public.current_factory_id(), sh.order_id, r.sheet_id, p_repeat_id,
    coalesce(st.stage_type, 'embroidery'), p_damage_type, 'worker', null,
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

  return jsonb_build_object('repeat_id', p_repeat_id, 'damage_id', v_damage_id);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Final Delivery Queue
-- ---------------------------------------------------------------------------
create or replace function public.dp_final_delivery_queue()
returns table (
  order_id         uuid,
  order_code       text,
  vendor_name      text,
  total_repeats    int,
  completed_repeats int,
  created_at       timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery','company_admin']);

  return query
  select
    o.id,
    o.order_code,
    v.name,
    (select count(*)::int from public.repeats r join public.sheets s on s.id = r.sheet_id where s.order_id = o.id),
    (select count(*)::int from public.repeats r join public.sheets s on s.id = r.sheet_id where s.order_id = o.id and r.current_status in ('awaiting_final_qa', 'completed')),
    o.created_at
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  where o.factory_id = public.current_factory_id()
    and o.status in ('ready_for_delivery', 'job_card_confirmed', 'in_production', 'in_finishing')
    and not exists (
      select 1 from public.repeats r
      join public.sheets s on s.id = r.sheet_id
      where s.order_id = o.id
        and r.current_status not in ('awaiting_final_qa', 'completed')
    )
  order by o.created_at asc;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Complete Delivery (Photo + Signature)
-- ---------------------------------------------------------------------------
create or replace function public.dp_complete_delivery(
  p_order_id             uuid,
  p_delivery_photo_url   text,
  p_delivery_signature   text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
  v_pending int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery','company_admin']);

  select * into o from public.orders where id = p_order_id and factory_id = public.current_factory_id();
  if not found then perform public.raise_not_found('Order not found.'); end if;

  if coalesce(trim(p_delivery_photo_url), '') = '' then
    raise exception 'Delivery photo is required.' using errcode = '22023';
  end if;

  if coalesce(trim(p_delivery_signature), '') = '' then
    raise exception 'Delivery signature is required.' using errcode = '22023';
  end if;

  -- Ensure no repeats are still in active stages
  select count(*) into v_pending
  from public.repeats r
  join public.sheets s on s.id = r.sheet_id
  where s.order_id = p_order_id
    and r.current_status not in ('awaiting_final_qa', 'completed');

  if v_pending > 0 then
    raise exception 'Cannot complete delivery: % repeat(s) still in production/finishing.', v_pending using errcode = '22023';
  end if;

  -- Mark order complete
  update public.orders
     set status = 'completed',
         delivery_photo_url = p_delivery_photo_url,
         delivery_signature_url = p_delivery_signature,
         delivered_at = now(),
         updated_at = now()
   where id = p_order_id;

  -- Mark all repeats complete
  update public.repeats
     set current_status = 'completed',
         updated_at = now()
   where id in (
     select r.id from public.repeats r join public.sheets s on s.id = r.sheet_id where s.order_id = p_order_id
   );

  return jsonb_build_object('order_id', p_order_id, 'status', 'completed');
end $$;

-- ---------------------------------------------------------------------------
-- 10. Scanner: Check SLA Breaches
-- ---------------------------------------------------------------------------
create or replace function public.check_sla_breaches()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select
      rsh.id as history_id,
      rsh.factory_id,
      rsh.repeat_id,
      rsh.order_stage_id
    from public.repeat_stage_history rsh
    join public.order_stages st on st.id = rsh.order_stage_id
    where rsh.handed_off_at is not null
      and rsh.returned_at is null
      and now() > rsh.handed_off_at + (st.sla_hours || ' hours')::interval
      and not exists (
        select 1 from public.sla_alerts sa
        where sa.repeat_id = rsh.repeat_id
          and sa.order_stage_id = rsh.order_stage_id
          and sa.resolved_at is null
      )
  loop
    insert into public.sla_alerts (factory_id, order_stage_id, repeat_id, history_id, triggered_at)
    values (r.factory_id, r.order_stage_id, r.repeat_id, r.history_id, now())
    on conflict do nothing;

    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- 11. List SLA Alerts
-- ---------------------------------------------------------------------------
create or replace function public.list_sla_alerts()
returns table (
  alert_id         uuid,
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  order_stage_id   uuid,
  stage_type       text,
  partner_name     text,
  triggered_at     timestamptz,
  hours_overdue    numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery','floor_manager','qa','company_admin']);

  return query
  select
    sa.id,
    r.id,
    r.repeat_code,
    o.id,
    o.order_code,
    st.id,
    st.stage_type,
    fp.name,
    sa.triggered_at,
    round(extract(epoch from (now() - (rsh.handed_off_at + (st.sla_hours || ' hours')::interval))) / 3600.0, 1)
  from public.sla_alerts sa
  join public.repeats r on r.id = sa.repeat_id
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  join public.order_stages st on st.id = sa.order_stage_id
  left join public.repeat_stage_history rsh on rsh.id = sa.history_id
  left join public.finishing_partners fp on fp.id = st.partner_id
  where sa.factory_id = public.current_factory_id()
    and sa.resolved_at is null
  order by sa.triggered_at asc;
end $$;

-- Grants
grant execute on function public.dp_handoff_queue() to authenticated;
grant execute on function public.dp_confirm_handoff(uuid,uuid,text) to authenticated;
grant execute on function public.dp_return_queue() to authenticated;
grant execute on function public.dp_confirm_return(uuid,text,boolean,text,text,text) to authenticated;
grant execute on function public.qa_collection_queue() to authenticated;
grant execute on function public.qa_collection_pass(uuid) to authenticated;
grant execute on function public.qa_collection_damage(uuid,text,text,text) to authenticated;
grant execute on function public.dp_final_delivery_queue() to authenticated;
grant execute on function public.dp_complete_delivery(uuid,text,text) to authenticated;
grant execute on function public.check_sla_breaches() to authenticated;
grant execute on function public.list_sla_alerts() to authenticated;
