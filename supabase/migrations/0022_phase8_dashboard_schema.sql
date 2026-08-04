-- =============================================================================
-- Factory ERP — Phase 8: Worker & Finishing Partner Read-Only Dashboards
-- Includes Phase 7 prerequisite tables: partner_ledger, loans
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Loans table (Phase 7 prerequisite - worker loan tracking)
-- ---------------------------------------------------------------------------
create table if not exists public.loans (
  id                 uuid primary key default gen_random_uuid(),
  factory_id         uuid not null default public.current_factory_id()
                       references public.factories(id) on delete cascade,
  worker_id          uuid not null references public.profiles(id) on delete restrict,
  principal          numeric(14,2) not null check (principal >= 0),
  balance            numeric(14,2) not null check (balance >= 0),
  installment_amount numeric(14,2) not null default 0 check (installment_amount >= 0),
  status             text not null default 'active' check (status in ('active', 'paid_off')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_loans_factory_worker on public.loans(factory_id, worker_id) where status = 'active';

drop trigger if exists trg_loans_touch on public.loans;
create trigger trg_loans_touch before update on public.loans
  for each row execute function public.touch_updated_at();

alter table public.loans enable row level security;

-- Worker can read their own loan; accountant/floor_manager/company_admin can read all
drop policy if exists loans_select on public.loans;
create policy loans_select on public.loans
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('machine_workforce')
    and (
      public.has_any_role(array['accountant','floor_manager','company_admin'])
      or worker_id = auth.uid()
    )
  );

-- Only accountant/company_admin can write loans
drop policy if exists loans_write on public.loans;
create policy loans_write on public.loans
  for all to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['accountant','company_admin'])
  )
  with check (factory_id = public.current_factory_id());

-- ---------------------------------------------------------------------------
-- 2. Partner Ledger table (Phase 7 prerequisite - partner payments/earnings)
-- ---------------------------------------------------------------------------
create table if not exists public.partner_ledger (
  id                 uuid primary key default gen_random_uuid(),
  factory_id         uuid not null default public.current_factory_id()
                       references public.factories(id) on delete cascade,
  partner_id         uuid not null references public.finishing_partners(id) on delete restrict,
  entry_type         text not null check (entry_type in ('earning', 'damage_charge', 'payment')),
  amount             numeric(14,2) not null,
  period             text not null,  -- YYYY-MM format
  repeat_id          uuid references public.repeats(id) on delete set null,
  damage_record_id   uuid references public.damage_records(id) on delete set null,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_partner_ledger_factory_partner on public.partner_ledger(factory_id, partner_id, period);
create index if not exists idx_partner_ledger_repeat on public.partner_ledger(repeat_id) where repeat_id is not null;
create index if not exists idx_partner_ledger_damage on public.partner_ledger(damage_record_id) where damage_record_id is not null;

alter table public.partner_ledger enable row level security;

-- Partner can read their own ledger; accountant/floor_manager/company_admin can read all
drop policy if exists partner_ledger_select on public.partner_ledger;
create policy partner_ledger_select on public.partner_ledger
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('order_lifecycle')
    and (
      public.has_any_role(array['accountant','floor_manager','company_admin'])
      or exists (
        select 1 from public.finishing_partners fp
        where fp.id = partner_ledger.partner_id
          and fp.user_id = auth.uid()
      )
    )
  );

-- Only accountant/company_admin can write partner ledger
drop policy if exists partner_ledger_write on public.partner_ledger;
create policy partner_ledger_write on public.partner_ledger
  for all to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
    and public.has_any_role(array['accountant','company_admin'])
  )
  with check (factory_id = public.current_factory_id());

-- ---------------------------------------------------------------------------
-- 3. Leaves table (Phase 8 - worker leave requests)
-- ---------------------------------------------------------------------------
create table if not exists public.leaves (
  id            uuid primary key default gen_random_uuid(),
  factory_id    uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  worker_id     uuid not null references public.profiles(id) on delete restrict,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reason        text not null,
  start_date    date not null,
  end_date      date not null,
  requested_at  timestamptz not null default now(),
  approved_by   uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_leaves_factory_worker on public.leaves(factory_id, worker_id, requested_at desc);

alter table public.leaves enable row level security;

-- Worker can read their own leaves; floor_manager/company_admin can read all in factory
drop policy if exists leaves_select on public.leaves;
create policy leaves_select on public.leaves
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('machine_workforce')
    and (
      public.has_any_role(array['floor_manager','company_admin'])
      or worker_id = auth.uid()
    )
  );

-- Worker can insert their own leave requests
drop policy if exists leaves_insert on public.leaves;
create policy leaves_insert on public.leaves
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and worker_id = auth.uid()
    and public.current_user_role() = 'worker'
  );

-- Floor manager/company_admin can update (approve/reject)
drop policy if exists leaves_update on public.leaves;
create policy leaves_update on public.leaves
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['floor_manager','company_admin'])
  )
  with check (factory_id = public.current_factory_id());

-- ---------------------------------------------------------------------------
-- 4. RPC Functions for Phase 8 Dashboards
-- ---------------------------------------------------------------------------

-- Worker: Get latest worker ledger entry (current period)
create or replace function public.worker_get_latest_ledger()
returns table (
  id                 uuid,
  period             text,
  stitch_count       int,
  base_per_stitch    numeric,
  bonus              numeric,
  damage_deduction   numeric,
  loan_installment   numeric,
  net                numeric,
  status             text,
  payment_proof_url  text,
  finalized_at       timestamptz,
  created_at         timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['worker','floor_manager','accountant','company_admin']);

  return query
  select wl.id, wl.period, wl.stitch_count, wl.base_per_stitch, wl.bonus,
         wl.damage_deduction, wl.loan_installment, wl.net, wl.status,
         wl.payment_proof_url, wl.finalized_at, wl.created_at
    from public.worker_ledger wl
   where wl.factory_id = public.current_factory_id()
     and wl.worker_id = auth.uid()
   order by wl.created_at desc
   limit 1;
end $$;

-- Worker: Get all ledger entries for salary breakdown
create or replace function public.worker_get_ledger_entries(p_period text default null)
returns setof public.worker_ledger
language plpgsql stable security definer set search_path = public as $$
declare v_period text := coalesce(p_period, public.current_payroll_period());
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['worker','floor_manager','accountant','company_admin']);

  return query
  select wl.*
    from public.worker_ledger wl
   where wl.factory_id = public.current_factory_id()
     and wl.worker_id = auth.uid()
     and wl.period = v_period
   order by wl.created_at;
end $$;

-- Worker: Get active loan
create or replace function public.worker_get_active_loan()
returns table (
  id                 uuid,
  principal          numeric,
  balance            numeric,
  installment_amount numeric,
  status             text,
  created_at         timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['worker','floor_manager','accountant','company_admin']);

  return query
  select l.id, l.principal, l.balance, l.installment_amount, l.status, l.created_at
    from public.loans l
   where l.factory_id = public.current_factory_id()
     and l.worker_id = auth.uid()
     and l.status = 'active'
   limit 1;
end $$;

-- Worker: Get leave history
create or replace function public.worker_get_leave_history()
returns table (
  id           uuid,
  status       text,
  reason       text,
  start_date   date,
  end_date     date,
  requested_at timestamptz,
  approved_by  uuid,
  approved_at  timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['worker','floor_manager','company_admin']);

  return query
  select l.id, l.status, l.reason, l.start_date, l.end_date,
         l.requested_at, l.approved_by, l.approved_at
    from public.leaves l
   where l.factory_id = public.current_factory_id()
     and l.worker_id = auth.uid()
   order by l.requested_at desc;
end $$;

-- Worker: Submit leave request
create or replace function public.worker_submit_leave(
  p_reason     text,
  p_start_date date,
  p_end_date   date
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['worker']);

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reason is required.' using errcode = '22023';
  end if;

  if p_start_date > p_end_date then
    raise exception 'Start date cannot be after end date.' using errcode = '22023';
  end if;

  insert into public.leaves (factory_id, worker_id, reason, start_date, end_date)
  values (public.current_factory_id(), auth.uid(), p_reason, p_start_date, p_end_date)
  returning id into v_id;

  return v_id;
end $$;

-- Worker: Get current or most recent shift for downtime reporting
create or replace function public.worker_get_current_shift()
returns table (
  id               uuid,
  machine_id       uuid,
  machine_name     text,
  order_id         uuid,
  order_code       text,
  opened_at        timestamptz,
  status           text
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['worker','floor_manager','company_admin']);

  return query
  select s.id, s.machine_id, m.name, s.order_id, o.order_code, s.opened_at, s.status
    from public.shifts s
    join public.machines m on m.id = s.machine_id
    left join public.orders o on o.id = s.order_id
   where s.factory_id = public.current_factory_id()
     and s.worker_id = auth.uid()
     and s.status in ('open', 'closed')
   order by s.opened_at desc
   limit 1;
end $$;

-- Worker: Report downtime (proactive, not during shift close)
create or replace function public.worker_report_downtime(
  p_shift_id       uuid,
  p_duration_minutes int,
  p_reason         text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
    v_shift public.shifts;
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['worker']);

  select * into v_shift
    from public.shifts
   where id = p_shift_id
     and factory_id = public.current_factory_id()
     and worker_id = auth.uid();

  if not found then
    perform public.raise_not_found('Shift not found or not yours.');
  end if;

  if p_duration_minutes <= 0 then
    raise exception 'Duration must be positive.' using errcode = '22023';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reason is required.' using errcode = '22023';
  end if;

  insert into public.downtime_reports (factory_id, shift_id, duration_minutes, reason, reported_by)
  values (public.current_factory_id(), p_shift_id, p_duration_minutes, trim(p_reason), auth.uid())
  returning id into v_id;

  return v_id;
end $$;

-- Partner: Get current period earnings summary
create or replace function public.partner_get_earnings_summary(p_period text default null)
returns table (
  total_earnings    numeric,
  total_damage_charges numeric,
  total_payments    numeric,
  net_receivable    numeric
)
language plpgsql stable security definer set search_path = public as $$
declare v_partner_id uuid;
    v_period text := coalesce(p_period, to_char(now() at time zone 'UTC', 'YYYY-MM'));
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','accountant','floor_manager','company_admin']);

  select id into v_partner_id
    from public.finishing_partners
   where user_id = auth.uid()
     and factory_id = public.current_factory_id()
     and deleted_at is null;

  if not found then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select
    coalesce(sum(case when pl.entry_type = 'earning' then pl.amount else 0 end), 0),
    coalesce(sum(case when pl.entry_type = 'damage_charge' then pl.amount else 0 end), 0),
    coalesce(sum(case when pl.entry_type = 'payment' then pl.amount else 0 end), 0),
    coalesce(sum(
      case
        when pl.entry_type = 'earning' then pl.amount
        when pl.entry_type = 'damage_charge' then -pl.amount
        when pl.entry_type = 'payment' then -pl.amount
        else 0
      end
    ), 0)
  from public.partner_ledger pl
  where pl.factory_id = public.current_factory_id()
    and pl.partner_id = v_partner_id
    and pl.period = v_period;
end $$;

-- Partner: Get completed work (repeats) for current period
create or replace function public.partner_get_completed_work(p_period text default null)
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_code       text,
  stage_type       text,
  completed_at     timestamptz,
  stitch_count     int,
  earning_amount   numeric
)
language plpgsql stable security definer set search_path = public as $$
declare v_partner_id uuid;
    v_period text := coalesce(p_period, to_char(now() at time zone 'UTC', 'YYYY-MM'));
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','accountant','floor_manager','company_admin']);

  select id into v_partner_id
    from public.finishing_partners
   where user_id = auth.uid()
     and factory_id = public.current_factory_id()
     and deleted_at is null;

  if not found then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select r.id, r.repeat_code, o.order_code, st.stage_type,
         rsh.returned_at,  -- when the stage was returned/completed
         case when st.stage_type = 'embroidery' then
           coalesce((
             select sum(jcl.stitch_count)
               from public.job_cards jc
               join public.job_card_lines jcl on jcl.job_card_id = jc.id
              where jc.order_id = o.id
           ), 0)
         else 0 end as stitch_count,
         pl.amount as earning_amount
    from public.partner_ledger pl
    join public.repeats r on r.id = pl.repeat_id
    join public.sheets sh on sh.id = r.sheet_id
    join public.orders o on o.id = sh.order_id
    join public.order_stages st on st.id = (
      select rsh2.order_stage_id
        from public.repeat_stage_history rsh2
       where rsh2.repeat_id = r.id
         and rsh2.returned_at is not null
       order by rsh2.returned_at desc
       limit 1
    )
    left join public.repeat_stage_history rsh on rsh.repeat_id = r.id
      and rsh.order_stage_id = st.id
      and rsh.returned_at is not null
   where pl.factory_id = public.current_factory_id()
     and pl.partner_id = v_partner_id
     and pl.entry_type = 'earning'
     and pl.period = v_period
   order by pl.created_at desc;
end $$;

-- Partner: Get damage charges
create or replace function public.partner_get_damage_charges(p_period text default null)
returns table (
  id                uuid,
  repeat_code       text,
  order_code        text,
  stage_type        text,
  damage_type       text,
  amount            numeric,
  photo_url         text,
  note              text,
  created_at        timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare v_partner_id uuid;
    v_period text := coalesce(p_period, to_char(now() at time zone 'UTC', 'YYYY-MM'));
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','accountant','floor_manager','company_admin']);

  select id into v_partner_id
    from public.finishing_partners
   where user_id = auth.uid()
     and factory_id = public.current_factory_id()
     and deleted_at is null;

  if not found then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select pl.id, r.repeat_code, o.order_code, dr.stage_type,
         dr.damage_type, pl.amount, dr.photo_url, dr.note, pl.created_at
    from public.partner_ledger pl
    join public.damage_records dr on dr.id = pl.damage_record_id
    join public.repeats r on r.id = dr.repeat_id
    join public.sheets sh on sh.id = r.sheet_id
    join public.orders o on o.id = sh.order_id
   where pl.factory_id = public.current_factory_id()
     and pl.partner_id = v_partner_id
     and pl.entry_type = 'damage_charge'
     and pl.period = v_period
   order by pl.created_at desc;
end $$;

-- Partner: Get payment history
create or replace function public.partner_get_payment_history()
returns table (
  id          uuid,
  amount      numeric,
  period      text,
  created_at  timestamptz,
  created_by_name text
)
language plpgsql stable security definer set search_path = public as $$
declare v_partner_id uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','accountant','floor_manager','company_admin']);

  select id into v_partner_id
    from public.finishing_partners
   where user_id = auth.uid()
     and factory_id = public.current_factory_id()
     and deleted_at is null;

  if not found then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select pl.id, pl.amount, pl.period, pl.created_at, p.display_name
    from public.partner_ledger pl
    left join public.profiles p on p.id = pl.created_by
   where pl.factory_id = public.current_factory_id()
     and pl.partner_id = v_partner_id
     and pl.entry_type = 'payment'
   order by pl.created_at desc;
end $$;

-- Grants
grant execute on function public.worker_get_latest_ledger() to authenticated;
grant execute on function public.worker_get_ledger_entries(text) to authenticated;
grant execute on function public.worker_get_active_loan() to authenticated;
grant execute on function public.worker_get_leave_history() to authenticated;
grant execute on function public.worker_submit_leave(text,date,date) to authenticated;
grant execute on function public.worker_get_current_shift() to authenticated;
grant execute on function public.worker_report_downtime(uuid,int,text) to authenticated;
grant execute on function public.partner_get_earnings_summary(text) to authenticated;
grant execute on function public.partner_get_completed_work(text) to authenticated;
grant execute on function public.partner_get_damage_charges(text) to authenticated;
grant execute on function public.partner_get_payment_history() to authenticated;