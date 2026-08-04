-- =============================================================================
-- Factory ERP — Phase 5 transition functions.
--
-- Shift close posts to worker_ledger via RPC only — never direct inserts from
-- the client. Bonus slabs are evaluated at posting time against the worker's
-- daily stitch total for that calendar day.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create or replace function public.assert_my_shift(p_shift_id uuid)
returns public.shifts
language plpgsql stable security definer set search_path = public as $$
declare s public.shifts;
begin
  select * into s from public.shifts where id = p_shift_id;
  if not found or s.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Shift not found.');
  end if;
  return s;
end $$;

create or replace function public.assert_my_machine(p_machine_id uuid)
returns public.machines
language plpgsql stable security definer set search_path = public as $$
declare m public.machines;
begin
  select * into m from public.machines where id = p_machine_id and deleted_at is null;
  if not found or m.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Machine not found.');
  end if;
  return m;
end $$;

-- Current payroll period (YYYY-MM).
create or replace function public.current_payroll_period()
returns text
language sql stable as $$
  select to_char(now() at time zone 'UTC', 'YYYY-MM')
$$;

-- Worker's stitch total for a calendar day (UTC), excluding flagged_idle.
create or replace function public.worker_daily_stitches(
  p_worker_id uuid,
  p_day       date default (now() at time zone 'UTC')::date
)
returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(wl.stitch_count), 0)::int
    from public.worker_ledger wl
   where wl.worker_id = p_worker_id
     and wl.factory_id = public.current_factory_id()
     and wl.created_at >= p_day::timestamptz
     and wl.created_at < (p_day + 1)::timestamptz
$$;

-- Highest bonus slab the worker qualifies for today after adding p_new_stitches.
create or replace function public.compute_shift_bonus(
  p_worker_id    uuid,
  p_new_stitches int
)
returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory   uuid := public.current_factory_id();
  v_today     date := (now() at time zone 'UTC')::date;
  v_daily     int;
  v_bonus     numeric(14,2) := 0;
  v_prev_bonus numeric(14,2) := 0;
  v_slab      record;
begin
  v_daily := public.worker_daily_stitches(p_worker_id, v_today) + p_new_stitches;

  -- Bonus = highest slab reached today minus any bonus already posted today.
  select coalesce(max(bs.bonus_amount), 0) into v_bonus
    from public.bonus_slabs bs
   where bs.factory_id = v_factory
     and bs.daily_stitch_threshold <= v_daily;

  select coalesce(max(wl.bonus), 0) into v_prev_bonus
    from public.worker_ledger wl
   where wl.worker_id = p_worker_id
     and wl.factory_id = v_factory
     and wl.created_at >= v_today::timestamptz
     and wl.created_at < (v_today + 1)::timestamptz;

  return greatest(v_bonus - v_prev_bonus, 0);
end $$;

-- ---------------------------------------------------------------------------
-- Machine context for assignment (reference aid)
-- ---------------------------------------------------------------------------
create or replace function public.fm_machine_context(p_machine_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_machine public.machines;
  v_prev    public.shifts;
  v_lines   jsonb;
begin
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_module('machine_workforce');

  v_machine := public.assert_my_machine(p_machine_id);

  -- Floor managers only see machines they manage (owner sees all).
  if public.current_user_role() = 'floor_manager'
     and v_machine.managed_by is distinct from auth.uid() then
    perform public.raise_not_found('Machine not found.');
  end if;

  select * into v_prev
    from public.shifts s
   where s.machine_id = p_machine_id
     and s.status in ('closed','flagged_idle')
   order by s.closed_at desc nulls last, s.created_at desc
   limit 1;

  v_lines := '[]'::jsonb;
  if v_prev.order_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'needle_number', jcl.needle_number,
      'thread_color_code', jcl.thread_color_code,
      'stitch_count', jcl.stitch_count
    ) order by jcl.needle_number), '[]'::jsonb)
      into v_lines
      from public.job_cards jc
      join public.job_card_lines jcl on jcl.job_card_id = jc.id
     where jc.order_id = v_prev.order_id;
  end if;

  return jsonb_build_object(
    'machine_id', v_machine.id,
    'machine_name', v_machine.name,
    'has_open_shift', exists(
      select 1 from public.shifts where machine_id = p_machine_id and status = 'open'
    ),
    'previous_order_id', v_prev.order_id,
    'previous_job_card_lines', v_lines,
    'inherited_open_photo_url', (
      select s.close_panel_photo_url
        from public.shifts s
       where s.machine_id = p_machine_id and s.status = 'closed'
       order by s.closed_at desc nulls last limit 1
    ),
    'inherited_open_stitches', coalesce((
      select s.confirmed_stitches
        from public.shifts s
       where s.machine_id = p_machine_id and s.status = 'closed'
       order by s.closed_at desc nulls last limit 1
    ), 0)
  );
end $$;

-- ---------------------------------------------------------------------------
-- List machines for floor manager
-- ---------------------------------------------------------------------------
create or replace function public.fm_list_machines()
returns table (
  id              uuid,
  name            text,
  has_open_shift  boolean,
  open_shift_id   uuid,
  worker_name     text,
  order_code      text
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_module('machine_workforce');

  return query
  select
    m.id,
    m.name,
    exists(select 1 from public.shifts s where s.machine_id = m.id and s.status = 'open'),
    os.id,
    wp.display_name,
    o.order_code
  from public.machines m
  left join lateral (
    select s.id, s.worker_id, s.order_id
      from public.shifts s
     where s.machine_id = m.id and s.status = 'open'
     limit 1
  ) os on true
  left join public.profiles wp on wp.id = os.worker_id
  left join public.orders o on o.id = os.order_id
  where m.factory_id = public.current_factory_id()
    and m.deleted_at is null
    and (
      public.current_user_role() = 'company_admin'
      or m.managed_by = auth.uid()
      or m.managed_by is null
    )
  order by m.name;
end $$;

-- ---------------------------------------------------------------------------
-- Open shift (machine assignment)
-- ---------------------------------------------------------------------------
create or replace function public.fm_open_shift(
  p_machine_id         uuid,
  p_worker_id          uuid,
  p_order_id           uuid,
  p_open_photo_url     text,
  p_open_stitches      int default 0
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_machine public.machines;
  v_shift_id uuid;
begin
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_module('machine_workforce');

  v_machine := public.assert_my_machine(p_machine_id);

  if public.current_user_role() = 'floor_manager'
     and v_machine.managed_by is distinct from auth.uid() then
    perform public.raise_not_found('Machine not found.');
  end if;

  if exists(select 1 from public.shifts where machine_id = p_machine_id and status = 'open') then
    raise exception 'This machine already has an open shift.' using errcode = '22023';
  end if;

  if not exists(
    select 1 from public.profiles
     where id = p_worker_id and factory_id = v_factory and role = 'worker' and is_active
  ) then
    raise exception 'Worker not found or inactive.' using errcode = '22023';
  end if;

  if p_order_id is not null then
    perform public.assert_my_order(p_order_id);
  end if;

  if coalesce(trim(p_open_photo_url), '') = '' then
    raise exception 'Open panel photo is required.' using errcode = '22023';
  end if;

  insert into public.shifts
    (factory_id, machine_id, worker_id, order_id,
     open_panel_photo_url, open_stitches, status, opened_by)
  values
    (v_factory, p_machine_id, p_worker_id, p_order_id,
     p_open_photo_url, coalesce(p_open_stitches, 0), 'open', auth.uid())
  returning id into v_shift_id;

  return v_shift_id;
end $$;

-- ---------------------------------------------------------------------------
-- Flag idle / counter reset — NO ledger posting
-- ---------------------------------------------------------------------------
create or replace function public.fm_flag_shift_idle(
  p_shift_id          uuid,
  p_close_photo_url   text default null,
  p_detected_stitches int default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare s public.shifts;
begin
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_module('machine_workforce');

  s := public.assert_my_shift(p_shift_id);

  if s.status <> 'open' then
    raise exception 'Only open shifts can be flagged idle.' using errcode = '22023';
  end if;

  update public.shifts
     set status = 'flagged_idle',
         close_panel_photo_url = coalesce(nullif(trim(p_close_photo_url), ''), close_panel_photo_url),
         detected_stitches = coalesce(p_detected_stitches, detected_stitches),
         closed_by = auth.uid(),
         closed_at = now()
   where id = p_shift_id;
end $$;

-- ---------------------------------------------------------------------------
-- Close shift — posts to worker_ledger
-- ---------------------------------------------------------------------------
create or replace function public.fm_close_shift(
  p_shift_id            uuid,
  p_close_photo_url     text,
  p_detected_stitches   int,
  p_confirmed_stitches  int,
  p_downtime_minutes    int default null,
  p_downtime_reason     text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s            public.shifts;
  v_stitches   int;
  v_rate       numeric(12,4);
  v_bonus      numeric(14,2);
  v_base       numeric(14,2);
  v_net        numeric(14,2);
  v_ledger_id  uuid;
  v_period     text;
begin
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_module('machine_workforce');

  s := public.assert_my_shift(p_shift_id);

  if s.status <> 'open' then
    raise exception 'Shift is not open.' using errcode = '22023';
  end if;

  if coalesce(trim(p_close_photo_url), '') = '' then
    raise exception 'Close panel photo is required.' using errcode = '22023';
  end if;

  if p_confirmed_stitches is null or p_confirmed_stitches < 0 then
    raise exception 'Confirmed stitch count is required.' using errcode = '22023';
  end if;

  if p_confirmed_stitches < s.open_stitches then
    raise exception 'Close count (%) cannot be less than open count (%).',
      p_confirmed_stitches, s.open_stitches using errcode = '22023';
  end if;

  v_stitches := p_confirmed_stitches - s.open_stitches;

  select coalesce(p.stitch_rate, 0) into v_rate
    from public.profiles p where p.id = s.worker_id;

  v_bonus := public.compute_shift_bonus(s.worker_id, v_stitches);
  v_base := round(v_stitches * v_rate, 2);
  v_net := v_base + v_bonus - 0 - 0;  -- damage/loan populated in Phases 6/7
  v_period := public.current_payroll_period();

  update public.shifts
     set close_panel_photo_url = p_close_photo_url,
         detected_stitches = p_detected_stitches,
         confirmed_stitches = p_confirmed_stitches,
         status = 'closed',
         closed_by = auth.uid(),
         closed_at = now()
   where id = p_shift_id;

  if p_downtime_minutes is not null and p_downtime_minutes > 0
     and coalesce(trim(p_downtime_reason), '') <> '' then
    insert into public.downtime_reports
      (factory_id, shift_id, duration_minutes, reason, reported_by)
    values
      (s.factory_id, p_shift_id, p_downtime_minutes, trim(p_downtime_reason), auth.uid());
  end if;

  insert into public.worker_ledger
    (factory_id, worker_id, shift_id, period, stitch_count,
     base_per_stitch, bonus, damage_deduction, loan_installment, net)
  values
    (s.factory_id, s.worker_id, p_shift_id, v_period, v_stitches,
     v_rate, v_bonus, 0, 0, v_net)
  returning id into v_ledger_id;

  return jsonb_build_object(
    'shift_id', p_shift_id,
    'ledger_id', v_ledger_id,
    'stitch_count', v_stitches,
    'base_amount', v_base,
    'bonus', v_bonus,
    'net', v_net
  );
end $$;

-- ---------------------------------------------------------------------------
-- Shift close walk list
-- ---------------------------------------------------------------------------
create or replace function public.fm_shift_close_queue()
returns table (
  shift_id      uuid,
  machine_id    uuid,
  machine_name  text,
  worker_name   text,
  order_code    text,
  opened_at     timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_module('machine_workforce');

  return query
  select
    s.id,
    m.id,
    m.name,
    wp.display_name,
    o.order_code,
    s.opened_at
  from public.shifts s
  join public.machines m on m.id = s.machine_id
  join public.profiles wp on wp.id = s.worker_id
  left join public.orders o on o.id = s.order_id
  where s.factory_id = public.current_factory_id()
    and s.status = 'open'
    and (
      public.current_user_role() = 'company_admin'
      or m.managed_by = auth.uid()
      or m.managed_by is null
    )
  order by m.name;
end $$;

-- ---------------------------------------------------------------------------
-- Accountant: salary run
-- ---------------------------------------------------------------------------
create or replace function public.acct_salary_run_summary(p_period text default null)
returns table (
  worker_id        uuid,
  worker_name      text,
  entry_count      bigint,
  total_stitches   bigint,
  total_base       numeric,
  total_bonus      numeric,
  total_deduction  numeric,
  total_loan       numeric,
  total_net        numeric,
  has_pending      boolean
)
language plpgsql stable security definer set search_path = public as $$
declare v_period text := coalesce(p_period, public.current_payroll_period());
begin
  perform public.assert_role(array['accountant','company_admin']);
  perform public.assert_module('machine_workforce');

  return query
  select
    wl.worker_id,
    p.display_name,
    count(*)::bigint,
    coalesce(sum(wl.stitch_count), 0)::bigint,
    round(coalesce(sum(wl.stitch_count * wl.base_per_stitch), 0), 2),
    coalesce(sum(wl.bonus), 0),
    coalesce(sum(wl.damage_deduction), 0),
    coalesce(sum(wl.loan_installment), 0),
    coalesce(sum(wl.net), 0),
    bool_or(wl.status = 'pending')
  from public.worker_ledger wl
  join public.profiles p on p.id = wl.worker_id
  where wl.factory_id = public.current_factory_id()
    and wl.period = v_period
  group by wl.worker_id, p.display_name
  order by p.display_name;
end $$;

create or replace function public.acct_worker_ledger_entries(
  p_worker_id uuid,
  p_period    text default null
)
returns setof public.worker_ledger
language plpgsql stable security definer set search_path = public as $$
declare v_period text := coalesce(p_period, public.current_payroll_period());
begin
  perform public.assert_role(array['accountant','company_admin']);
  perform public.assert_module('machine_workforce');

  return query
  select wl.*
    from public.worker_ledger wl
   where wl.factory_id = public.current_factory_id()
     and wl.worker_id = p_worker_id
     and wl.period = v_period
   order by wl.created_at;
end $$;

create or replace function public.acct_finalize_salary_run(
  p_period     text default null,
  p_worker_ids uuid[] default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_period text := coalesce(p_period, public.current_payroll_period());
  v_count  int;
begin
  perform public.assert_role(array['accountant','company_admin']);
  perform public.assert_module('machine_workforce');

  update public.worker_ledger wl
     set status = 'finalized',
         finalized_at = now(),
         finalized_by = auth.uid()
   where wl.factory_id = public.current_factory_id()
     and wl.period = v_period
     and wl.status = 'pending'
     and (p_worker_ids is null or wl.worker_id = any(p_worker_ids));

  get diagnostics v_count = row_count;

  return jsonb_build_object('finalized_count', v_count, 'period', v_period);
end $$;

create or replace function public.acct_attach_payment_proof(
  p_ledger_ids        uuid[],
  p_payment_proof_url text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  perform public.assert_role(array['accountant','company_admin']);
  perform public.assert_module('machine_workforce');

  if coalesce(trim(p_payment_proof_url), '') = '' then
    raise exception 'Payment proof URL is required.' using errcode = '22023';
  end if;

  update public.worker_ledger wl
     set payment_proof_url = p_payment_proof_url
   where wl.id = any(p_ledger_ids)
     and wl.factory_id = public.current_factory_id()
     and wl.status = 'finalized';

  get diagnostics v_count = row_count;

  return jsonb_build_object('updated_count', v_count);
end $$;

-- ---------------------------------------------------------------------------
-- Owner: bonus slabs
-- ---------------------------------------------------------------------------
create or replace function public.owner_upsert_bonus_slab(
  p_id                     uuid default null,
  p_daily_stitch_threshold int default null,
  p_bonus_amount           numeric default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.assert_role(array['company_admin']);
  perform public.assert_module('machine_workforce');

  if p_id is null then
    insert into public.bonus_slabs (daily_stitch_threshold, bonus_amount)
    values (p_daily_stitch_threshold, p_bonus_amount)
    returning id into v_id;
  else
    update public.bonus_slabs
       set daily_stitch_threshold = coalesce(p_daily_stitch_threshold, daily_stitch_threshold),
           bonus_amount = coalesce(p_bonus_amount, bonus_amount)
     where id = p_id and factory_id = public.current_factory_id()
    returning id into v_id;
    if v_id is null then perform public.raise_not_found('Bonus slab not found.'); end if;
  end if;

  return v_id;
end $$;

create or replace function public.owner_delete_bonus_slab(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_role(array['company_admin']);
  perform public.assert_module('machine_workforce');

  delete from public.bonus_slabs
   where id = p_id and factory_id = public.current_factory_id();

  if not found then perform public.raise_not_found('Bonus slab not found.'); end if;
end $$;

-- ---------------------------------------------------------------------------
-- List workers (for assignment picker)
-- ---------------------------------------------------------------------------
create or replace function public.list_factory_workers()
returns table (id uuid, display_name text, stitch_rate numeric)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.stitch_rate
    from public.profiles p
   where p.factory_id = public.current_factory_id()
     and p.role = 'worker'
     and p.is_active
   order by p.display_name
$$;

-- Grants
grant execute on function public.fm_machine_context(uuid) to authenticated;
grant execute on function public.fm_list_machines() to authenticated;
grant execute on function public.fm_open_shift(uuid,uuid,uuid,text,int) to authenticated;
grant execute on function public.fm_flag_shift_idle(uuid,text,int) to authenticated;
grant execute on function public.fm_close_shift(uuid,text,int,int,int,text) to authenticated;
grant execute on function public.fm_shift_close_queue() to authenticated;
grant execute on function public.acct_salary_run_summary(text) to authenticated;
grant execute on function public.acct_worker_ledger_entries(uuid,text) to authenticated;
grant execute on function public.acct_finalize_salary_run(text,uuid[]) to authenticated;
grant execute on function public.acct_attach_payment_proof(uuid[],text) to authenticated;
grant execute on function public.owner_upsert_bonus_slab(uuid,int,numeric) to authenticated;
grant execute on function public.owner_delete_bonus_slab(uuid) to authenticated;
grant execute on function public.list_factory_workers() to authenticated;
