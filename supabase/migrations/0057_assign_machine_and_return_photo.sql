-- =============================================================================
-- Factory ERP — Fix 2 (Complete Return needs a photo) and Fix 3 (Assign Machine
-- is ONE action).
--
-- FIX 3 — WHAT IS AND ISN'T BEING REMOVED
-- ---------------------------------------
-- "No need to assign a shift separately" removes the NAVIGATION DETOUR, not the
-- shift record. `fm_assign_machine` (0041) refuses unless the machine already
-- has an open shift, which forced the Floor Manager out to the Shift Calendar,
-- back to the Orders box, and into the modal again. This migration folds the
-- shift open INTO the assignment so it is one call.
--
-- The `shifts` row itself is emphatically NOT dropped: Phase 5 payroll pays per
-- stitch, and it computes that from `open_stitches` on the shift against the
-- close reading. No shift row means no payable work for anyone on that machine.
-- So the combined call still opens a real shift with a real worker, and simply
-- captures the worker photo / worker / start time inline instead of on a second
-- screen.
--
-- The panel photo and opening stitch count stay OPTIONAL here, unlike
-- `fm_open_shift` where they are mandatory. That is a real trade-off and worth
-- stating plainly: a shift opened through this path with no baseline reading
-- starts at 0 stitches, which over-credits the worker for whatever was already
-- on the counter. The screen therefore still offers both fields; they are
-- optional so that one missing photo cannot block production start, not because
-- they stopped mattering. `fm_open_shift` is untouched and remains the strict
-- path used by the Shift Calendar.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Assign a machine AND open its shift, in one call.
-- ---------------------------------------------------------------------------
create or replace function public.fm_assign_machine_with_shift(
  p_order_id            uuid,
  p_machine_id          uuid,
  p_worker_id           uuid,
  p_worker_photo_url    text,
  p_reported_start_time timestamptz default null,
  p_open_photo_url      text default null,
  p_open_stitches       int default 0
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory  uuid := public.current_factory_id();
  v_order    public.orders;
  v_machine  public.machines;
  v_shift_id uuid;
  v_reused   boolean := false;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  v_order := public.assert_my_order(p_order_id);
  if v_order.status <> 'machine_selection_pending' then
    raise exception 'This order is not awaiting machine selection (status: %).', v_order.status
      using errcode = '22023';
  end if;

  v_machine := public.assert_my_machine(p_machine_id);
  -- Same visibility rule as fm_assign_machine: a floor manager only sees the
  -- machines they manage, and a machine they don't manage must 404, not 403 —
  -- a 403 would confirm the machine exists.
  if public.current_user_role() = 'floor_manager'
     and v_machine.managed_by is distinct from auth.uid() then
    perform public.raise_not_found('Machine not found.');
  end if;

  if coalesce(trim(p_worker_photo_url), '') = '' then
    raise exception 'A photo of the worker is required.' using errcode = '22023';
  end if;

  -- Reuse an already-open shift rather than failing. The Floor Manager pressing
  -- one button should not have to know whether someone already opened this
  -- machine today.
  select id into v_shift_id
    from public.shifts
   where machine_id = p_machine_id and status = 'open'
   limit 1;

  if v_shift_id is not null then
    v_reused := true;
    -- Attach the shift to this order if it was opened without one.
    update public.shifts
       set order_id = coalesce(order_id, p_order_id),
           worker_photo_url = coalesce(worker_photo_url, p_worker_photo_url)
     where id = v_shift_id;
  else
    if not exists (
      select 1 from public.profiles
       where id = p_worker_id and factory_id = v_factory and role = 'worker' and is_active
    ) then
      raise exception 'Select an active worker to open the shift.' using errcode = '22023';
    end if;

    insert into public.shifts
      (factory_id, machine_id, worker_id, order_id,
       open_panel_photo_url, open_stitches, status, opened_by,
       worker_photo_url, reported_start_time)
    values
      (v_factory, p_machine_id, p_worker_id, p_order_id,
       nullif(trim(coalesce(p_open_photo_url, '')), ''), coalesce(p_open_stitches, 0),
       'open', auth.uid(),
       p_worker_photo_url, coalesce(p_reported_start_time, now()))
    returning id into v_shift_id;
  end if;

  update public.orders
     set assigned_machine_id = p_machine_id
   where id = p_order_id;

  return jsonb_build_object(
    'order_id',   p_order_id,
    'machine_id', p_machine_id,
    'shift_id',   v_shift_id,
    'reused_shift', v_reused
  );
end $$;

grant execute on function public.fm_assign_machine_with_shift(uuid, uuid, uuid, text, timestamptz, text, int)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Complete Return now requires proof (Fix 2)
--
-- Both variants get the requirement. The Returns board renders ONE "Complete
-- return" button over two underlying kinds (a finishing repeat and an Initial-QA
-- rejection), so requiring the photo on only one of them would make the same
-- button mean two different things depending on the row.
--
-- The photo is stored on the history row / damage record rather than on
-- `repeats`: it is evidence of a specific event, and evidence belongs with the
-- event, not with the current-state cache.
-- ---------------------------------------------------------------------------
alter table public.damage_records
  add column if not exists ot_return_photo_url text;

create or replace function public.ot_complete_return(
  p_repeat_id uuid,
  p_photo_url text default null,
  p_note      text default null
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory    uuid := public.current_factory_id();
  v_all        boolean;
  v_repeat     public.repeats;
  v_order_id   uuid;
  v_created_by uuid;
  v_handoffs   int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['order_taker','company_admin']);
  v_all := public.current_user_role() = 'company_admin';

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the piece handed back to the vendor is required.'
      using errcode = '22023';
  end if;

  -- A record variable cannot share an INTO list with another target, so the
  -- repeat and its order_id (via the sheet) are fetched in two steps.
  select r.* into v_repeat
    from public.repeats r
   where r.id = p_repeat_id
     and r.factory_id = v_factory;

  if v_repeat.id is null then
    perform public.raise_not_found('Repeat not found.');
  end if;

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  select created_by into v_created_by from public.orders where id = v_order_id;
  if not v_all and v_created_by is distinct from auth.uid() then
    perform public.raise_not_found('Repeat not found.');
  end if;

  if v_repeat.ot_return_confirmed_at is not null
     or v_repeat.current_status in ('awaiting_final_qa', 'awaiting_qa_final', 'completed', 'damaged') then
    raise exception 'This repeat is not an active return.' using errcode = '22023';
  end if;

  select count(*) into v_handoffs
    from public.repeat_stage_history
   where repeat_id = p_repeat_id
     and handed_off_at is not null;

  if v_handoffs = 0 then
    raise exception 'This repeat has not been handed off yet.' using errcode = '22023';
  end if;

  -- Audit trail only — deliberately not routed through log_repeat_stage, which
  -- would also overwrite current_status (see 0036's header).
  insert into public.repeat_stage_history
    (factory_id, repeat_id, status, actor_user_id, photo_url, note)
  values
    (v_factory, p_repeat_id, 'return_confirmed_by_order_taker', auth.uid(), p_photo_url, p_note);

  update public.repeats
     set ot_return_confirmed_at = now()
   where id = p_repeat_id
  returning * into v_repeat;

  return v_repeat;
end $$;

create or replace function public.ot_complete_qa_return(
  p_damage_id uuid,
  p_photo_url text default null,
  p_note      text default null
)
returns public.damage_records
language plpgsql security definer set search_path = public as $$
declare
  v_factory    uuid := public.current_factory_id();
  v_all        boolean;
  v_damage     public.damage_records;
  v_created_by uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['order_taker','company_admin']);
  v_all := public.current_user_role() = 'company_admin';

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the piece handed back to the vendor is required.'
      using errcode = '22023';
  end if;

  select d.* into v_damage
    from public.damage_records d
   where d.id = p_damage_id
     and d.factory_id = v_factory
     and d.stage_type = 'repeat_qa'
     and d.repeat_id is null;

  if v_damage.id is null then
    perform public.raise_not_found('Rejected piece not found.');
  end if;

  select created_by into v_created_by from public.orders where id = v_damage.order_id;
  if not v_all and v_created_by is distinct from auth.uid() then
    perform public.raise_not_found('Rejected piece not found.');
  end if;

  if v_damage.ot_return_confirmed_at is not null then
    raise exception 'This return has already been completed.' using errcode = '22023';
  end if;

  update public.damage_records
     set ot_return_confirmed_at = now(),
         ot_return_note = p_note,
         ot_return_photo_url = p_photo_url
   where id = p_damage_id
  returning * into v_damage;

  return v_damage;
end $$;

-- The 2-argument overloads must go. PostgREST resolves overloads by the NAMES
-- of the arguments supplied, so leaving `(uuid, text)` in place next to the new
-- `(uuid, text, text)` means a client sending {p_repeat_id, p_note} silently
-- binds to the OLD function and skips the photo requirement entirely — the
-- exact bug 0054 already documented for this pair of functions.
drop function if exists public.ot_complete_return(uuid, text);
drop function if exists public.ot_complete_qa_return(uuid, text);

grant execute on function public.ot_complete_return(uuid, text, text) to authenticated;
grant execute on function public.ot_complete_qa_return(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Boards that enumerate "finished" statuses need the new one
--
-- `awaiting_qa_final` sits between the Floor Manager's final check and QA's
-- real final pass. Any query that lists terminal-ish states by enumeration has
-- to learn about it, or a repeat vanishes from the board the moment the Floor
-- Manager signs off and reappears when QA does.
-- ---------------------------------------------------------------------------
create or replace function public.qa_final_queue()
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  vendor_name      text,
  sheet_number     int,
  color_assignment text,
  sent_at          timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  return query
  select r.id, r.repeat_code, o.id, o.order_code, coalesce(v.name, '—'),
         sh.sheet_number, sh.color_assignment,
         (select max(h.created_at) from public.repeat_stage_history h
           where h.repeat_id = r.id and h.status = 'awaiting_qa_final')
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  left join public.vendors v on v.id = o.vendor_id
  where r.factory_id = v_factory
    and r.current_status = 'awaiting_qa_final'
  order by o.created_at asc, r.repeat_code asc;
end $$;

grant execute on function public.qa_final_queue() to authenticated;

-- The Order Taker's Returns board buckets by status. Without this, a repeat the
-- Floor Manager has just cleared reads as still "active".
create or replace function public.ot_return_bucket(p_status text, p_confirmed timestamptz)
returns text
language sql immutable set search_path = public as $$
  select case
    when p_status in ('awaiting_final_qa', 'awaiting_qa_final', 'completed')
      or p_confirmed is not null
    then 'completed' else 'active' end;
$$;

grant execute on function public.ot_return_bucket(text, timestamptz) to authenticated;
