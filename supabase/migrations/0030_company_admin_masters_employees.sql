-- =============================================================================
-- Factory ERP — Company Admin: Masters tabs + Employees
--
-- Two features land here:
--
--   1. MASTERS TABS. The four master entities gain the fields the Owner's
--      consolidated Masters section needs:
--        vendors             += rate_per_repeat, rate_per_stitch, price
--        suppliers           += address, payment_day
--        machines            += machine_type
--        finishing_partners  += is_extended_partner
--      Plus live stat-panel functions (master_*_stats) that read the
--      transaction tables — orders/invoices/payments/POs/shifts/repeats/
--      partner_ledger — never a copy.
--
--   2. EMPLOYEES. `employee_compensation` records how each staff member is
--      paid (per_month / per_day / per_stitch). The Owner's Add Employee flow
--      calls create_employee, a SECURITY DEFINER function that makes the auth
--      login + profile + compensation row in one transaction — the only way to
--      create a login, since profiles writes are super-admin-only by RLS.
--
--      The accountant's Salary Run branches by salary_type: per_stitch keeps
--      the existing shift-close posting; per_day = daily rate x days worked;
--      per_month = flat salary. Fixed-salary rows are created at finalize time
--      (shift_id IS NULL marks them) so the shift-driven summary and the
--      loan-capping logic in 0027 are untouched.
--
-- Roles: `manager` and `labour` are added to the roles reference table so the
-- profile FK accepts them (profiles.role is a FK to roles.key — no CHECK to
-- alter here).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Masters: new columns
-- ---------------------------------------------------------------------------
alter table public.vendors
  add column if not exists rate_per_repeat numeric(12,4) check (rate_per_repeat is null or rate_per_repeat >= 0),
  add column if not exists rate_per_stitch numeric(12,4) check (rate_per_stitch is null or rate_per_stitch >= 0),
  add column if not exists price          numeric(14,2) check (price is null or price >= 0);

alter table public.suppliers
  add column if not exists address     text,
  add column if not exists payment_day int;

alter table public.suppliers drop constraint if exists suppliers_payment_day_chk;
alter table public.suppliers add constraint suppliers_payment_day_chk
  check (payment_day is null or payment_day between 1 and 31);

alter table public.machines
  add column if not exists machine_type text not null default 'sewing_machine';

alter table public.machines drop constraint if exists machines_machine_type_chk;
alter table public.machines add constraint machines_machine_type_chk
  check (machine_type in (
    'sewing_machine','overlock','flatlock','embroidery_machine','cutter',
    'press_machine','button_attaching','piko','karandi','fusing','other'
  ));

alter table public.finishing_partners
  add column if not exists is_extended_partner boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. Roles: manager + labour (profiles.role FK -> roles.key)
-- ---------------------------------------------------------------------------
insert into public.roles (key, name) values
  ('manager', 'Manager'),
  ('labour',  'Labour')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. employee_compensation
-- ---------------------------------------------------------------------------
create table if not exists public.employee_compensation (
  id            uuid primary key default gen_random_uuid(),
  factory_id    uuid not null references public.factories(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  role          text not null references public.roles(key),
  salary_type   text not null check (salary_type in ('per_month','per_day','per_stitch')),
  salary_amount numeric(14,2) not null check (salary_amount >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id)
);

create index if not exists idx_emp_comp_factory on public.employee_compensation(factory_id, created_at);

drop trigger if exists trg_employee_compensation_touch on public.employee_compensation;
create trigger trg_employee_compensation_touch before update on public.employee_compensation
  for each row execute function public.touch_updated_at();

alter table public.employee_compensation enable row level security;

-- Reads: the roles that touch payroll. Writes: none directly — the only path is
-- create_employee (SECURITY DEFINER, owner rights bypass RLS).
--
-- Super admin is deliberately NOT on this policy. 0028 stripped
-- `or is_super_admin()` out of every business-data select policy and granted it
-- back on exactly two tables (thread_stock, stock_movements); salaries are not
-- one of them. The clause was also written outside the `using (...)` parens,
-- which is a plain syntax error — so it never worked, it only broke the file.
drop policy if exists employee_compensation_select on public.employee_compensation;
create policy employee_compensation_select on public.employee_compensation
  for select to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin','accountant'])
  );

-- ---------------------------------------------------------------------------
-- 4. create_employee — one transaction for login + profile + compensation
-- ---------------------------------------------------------------------------
create or replace function public.create_employee(
  p_email         text,
  p_password      text,
  p_display_name  text,
  p_role          text,
  p_salary_type   text,
  p_salary_amount numeric
)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_factory uuid := public.current_factory_id();
  v_user_id uuid;
  v_email   text := lower(trim(p_email));
begin
  perform public.assert_role(array['company_admin']);

  if p_role not in ('worker','manager','qa','labour','delivery','order_taker') then
    raise exception 'Role % is not an employee role.', p_role using errcode = '22023';
  end if;
  if p_salary_type not in ('per_month','per_day','per_stitch') then
    raise exception 'Invalid salary type.' using errcode = '22023';
  end if;
  if p_salary_amount < 0 then
    raise exception 'Salary amount cannot be negative.' using errcode = '22023';
  end if;
  if v_email = '' or coalesce(trim(p_password), '') = '' or char_length(p_password) < 8 then
    raise exception 'An email and a password of at least 8 characters are required.' using errcode = '22023';
  end if;
  if p_display_name is null or trim(p_display_name) = '' then
    raise exception 'Display name is required.' using errcode = '22023';
  end if;

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token,
      email_change_token_new, email_change_token_current, email_change,
      phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
      v_email, crypt(p_password, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false,
      '', '', '', '', '', '', '', ''
    )
    returning id into v_user_id;

    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_user_id::text, v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email),
      'email', now(), now(), now()
    );
  exception
    when unique_violation then
      raise exception 'An account with that email already exists.' using errcode = '23505';
  end;

  insert into public.profiles (id, factory_id, role, display_name)
  values (v_user_id, v_factory, p_role, trim(p_display_name));

  insert into public.employee_compensation (factory_id, user_id, role, salary_type, salary_amount)
  values (v_factory, v_user_id, p_role, p_salary_type, p_salary_amount);

  -- Piece-rate workers need their rate on the profile too: shift close
  -- snapshots profiles.stitch_rate into worker_ledger.base_per_stitch.
  if p_salary_type = 'per_stitch' then
    update public.profiles set stitch_rate = p_salary_amount where id = v_user_id;
  end if;

  return jsonb_build_object('id', v_user_id, 'email', v_email);
end $$;

-- ---------------------------------------------------------------------------
-- 5. deactivate_employee — is_active toggle (history stays intact)
-- ---------------------------------------------------------------------------
create or replace function public.deactivate_employee(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_role(array['company_admin']);

  update public.profiles
     set is_active = false
   where id = p_user_id
     and factory_id = public.current_factory_id();

  if not found then perform public.raise_not_found('Employee not found.'); end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Masters stat panels (factory-wide, live, scoped by current_factory_id)
-- ---------------------------------------------------------------------------

-- Client = vendors (relabel). Invoiced/collected/remaining are the receivable
-- facts an owner checks before planning work for a client.
create or replace function public.master_client_stats()
returns table (
  total_clients int,
  active_orders int,
  invoiced     numeric,
  collected    numeric,
  remaining    numeric
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid),
  agg as (
    select
      (select count(*)::int from public.vendors v
        where v.factory_id = f.fid and v.deleted_at is null) as total_clients,
      (select count(*)::int from public.orders o
        where o.factory_id = f.fid and o.status not in ('completed','cancelled')) as active_orders,
      (select coalesce(sum(i.amount), 0) from public.invoices i
        where i.factory_id = f.fid and i.status <> 'cancelled') as invoiced,
      (select coalesce(sum(p.amount), 0) from public.payments p
        where p.factory_id = f.fid and p.direction = 'receivable'
          and p.ref_type = 'invoice') as collected
    from f
  )
  select total_clients, active_orders, invoiced, collected,
         invoiced - collected as remaining
  from agg;
$$;

-- Supplier payables: PO value vs cash actually paid, for the owner's view of
-- what's owed and what still needs approving.
create or replace function public.master_supplier_stats()
returns table (
  total_suppliers int,
  open_pos        int,
  po_value        numeric,
  paid            numeric,
  remaining       numeric
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid),
  agg as (
    select
      (select count(*)::int from public.suppliers s
        where s.factory_id = f.fid and s.deleted_at is null) as total_suppliers,
      (select count(*)::int from public.purchase_orders po
        where po.factory_id = f.fid
          and po.status not in ('paid','received','cancelled')) as open_pos,
      (select coalesce(sum(po.amount), 0) from public.purchase_orders po
        where po.factory_id = f.fid and po.status <> 'cancelled'
          and po.amount is not null) as po_value,
      (select coalesce(sum(p.amount), 0) from public.payments p
        where p.factory_id = f.fid and p.direction = 'payable'
          and p.ref_type = 'po'
          and exists (select 1 from public.purchase_orders po2
                       where po2.id = p.ref_id and po2.factory_id = f.fid)) as paid
    from f
  )
  select total_suppliers, open_pos, po_value, paid,
         po_value - paid as remaining
  from agg;
$$;

-- Machine fleet health: closed-shift run time vs reported downtime.
create or replace function public.master_machine_stats()
returns table (
  total_machines   int,
  active_7d        int,
  shifts_closed    int,
  run_minutes      numeric,
  downtime_minutes numeric,
  uptime_pct       numeric
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid),
  sh as (
    select s.id, s.machine_id, s.status, s.opened_at,
           extract(epoch from (coalesce(s.closed_at, now()) - s.opened_at)) / 60 as span_min
    from public.shifts s
    where s.factory_id = (select fid from f)
  ),
  dt as (
    select d.shift_id, sum(d.duration_minutes) as mins
    from public.downtime_reports d
    where d.factory_id = (select fid from f)
    group by d.shift_id
  ),
  agg as (
    select
      (select count(*)::int from public.machines m
        where m.factory_id = (select fid from f) and m.deleted_at is null) as total_machines,
      (select count(distinct m.id)::int from public.machines m
        join sh s on s.machine_id = m.id
        where m.factory_id = (select fid from f) and m.deleted_at is null
          and s.opened_at >= now() - interval '7 days') as active_7d,
      count(sh.id) filter (where sh.status = 'closed')::int as shifts_closed,
      round(coalesce(sum(sh.span_min) filter (where sh.status = 'closed'), 0), 1) as run_minutes,
      round(coalesce(sum(dt.mins), 0), 1) as downtime_minutes
    from sh
    left join dt on dt.shift_id = sh.id
  )
  select total_machines, active_7d, shifts_closed, run_minutes, downtime_minutes,
         case
           when run_minutes = 0 then null
           else round(100 * greatest(run_minutes - downtime_minutes, 0) / run_minutes, 1)
         end as uptime_pct
  from agg;
$$;

-- Finishing partner panel. Two money figures are deliberately distinct:
--   income   — what the partners actually earned (partner_ledger earnings)
--   revenue  — factory revenue on orders that flowed through a partner, so the
--              owner sees both what partners made and what the factory billed
--              on the work that passed through them.
create or replace function public.master_partner_stats()
returns table (
  total_partners   int,
  repeats_in_hand  int,
  handed_off_total int,
  income           numeric,
  revenue          numeric,
  damage_count     int,
  damage_deduction numeric
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid)
  select
    (select count(*)::int from public.finishing_partners fp
      where fp.factory_id = f.fid and fp.deleted_at is null) as total_partners,
    (select count(*)::int from public.repeat_stage_history h
      where h.factory_id = f.fid and h.partner_id is not null
        and h.handed_off_at is not null and h.returned_at is null) as repeats_in_hand,
    (select count(distinct h.repeat_id)::int from public.repeat_stage_history h
      where h.factory_id = f.fid and h.partner_id is not null
        and h.handed_off_at is not null) as handed_off_total,
    (select coalesce(sum(pl.amount), 0) from public.partner_ledger pl
      where pl.factory_id = f.fid and pl.entry_type = 'earning') as income,
    (select coalesce(sum(i.amount), 0)
       from public.invoices i
       join public.orders o on o.id = i.order_id
      where i.factory_id = f.fid and i.status <> 'cancelled'
        and exists (
          select 1 from public.order_stages os
           join public.finishing_partners fp2 on fp2.id = os.partner_id
          where os.order_id = o.id and fp2.factory_id = f.fid
        )) as revenue,
    (select count(*)::int from public.damage_records d
      where d.factory_id = f.fid and d.responsible_type = 'partner'
        and d.approval_status = 'approved') as damage_count,
    (select coalesce(sum(d.deduction), 0) from public.damage_records d
      where d.factory_id = f.fid and d.responsible_type = 'partner'
        and d.approval_status = 'approved') as damage_deduction
  from f;
$$;

-- ---------------------------------------------------------------------------
-- 7. Salary Run branches by salary_type
-- ---------------------------------------------------------------------------

-- Summary: per_stitch workers come from worker_ledger (shift-close posting);
-- per_day / per_month employees are shown with their computed totals and are
-- "pending" until finalize creates their fixed row (marked by shift_id IS NULL).
-- Return type changes, so the 0017 version must be dropped first.
drop function if exists public.acct_salary_run_summary(text);

create or replace function public.acct_salary_run_summary(p_period text default null)
returns table (
  worker_id       uuid,
  worker_name     text,
  entry_count     bigint,
  total_stitches  bigint,
  total_base      numeric,
  total_bonus     numeric,
  total_deduction numeric,
  total_loan      numeric,
  total_net       numeric,
  has_pending     boolean,
  salary_type     text
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid),
  v_period as (select coalesce(p_period, public.current_payroll_period()) as val),
  shift_rows as (
    select
      wl.worker_id,
      p.display_name,
      count(*)::bigint as entry_count,
      coalesce(sum(wl.stitch_count), 0)::bigint as total_stitches,
      round(coalesce(sum(wl.stitch_count * wl.base_per_stitch), 0), 2) as total_base,
      coalesce(sum(wl.bonus), 0) as total_bonus,
      coalesce(sum(wl.damage_deduction), 0) as total_deduction,
      coalesce(sum(wl.loan_installment), 0) as total_loan,
      coalesce(sum(wl.net), 0) as total_net,
      bool_or(wl.status = 'pending') as has_pending
    from public.worker_ledger wl
    join public.profiles p on p.id = wl.worker_id, f, v_period
    where wl.factory_id = f.fid
      and wl.period = v_period.val
      -- Fixed-salary employees are reported through the second branch only.
      and not exists (
        select 1 from public.employee_compensation ec3
         where ec3.user_id = wl.worker_id and ec3.factory_id = f.fid
           and ec3.salary_type in ('per_day','per_month')
      )
    group by wl.worker_id, p.display_name
  ),
  fixed_rows as (
    select
      ec.user_id as worker_id,
      p.display_name,
      ec.salary_type,
      case
        when ec.salary_type = 'per_month' then ec.salary_amount
        else ec.salary_amount * count(distinct wl.created_at::date)
      end as amount,
      count(wl.id)::bigint as days_worked
    -- `f` and `v_period` are read as scalar subqueries rather than comma-joined:
    -- a JOIN's ON clause cannot reference a FROM item to the left of a comma
    -- ("invalid reference to FROM-clause entry"), which is what
    -- `join p on ..., f, v_period left join wl on ... f.fid` would have hit.
    from public.employee_compensation ec
    join public.profiles p on p.id = ec.user_id
    left join public.worker_ledger wl
           on wl.worker_id = ec.user_id
          and wl.factory_id = ec.factory_id
          and wl.period = (select val from v_period)
    where ec.factory_id = (select fid from f)
      and ec.salary_type in ('per_day','per_month')
    group by ec.user_id, p.display_name, ec.salary_type, ec.salary_amount
  )
  select
    sr.worker_id, sr.display_name, sr.entry_count, sr.total_stitches, sr.total_base,
    sr.total_bonus, sr.total_deduction, sr.total_loan, sr.total_net, sr.has_pending,
    coalesce(ec.salary_type, 'per_stitch') as salary_type
  from shift_rows sr
  left join public.employee_compensation ec
         on ec.user_id = sr.worker_id and ec.factory_id = (select fid from f)
  union all
  select
    fr.worker_id, fr.display_name,
    case when fr.amount > 0 then 1 else 0 end::bigint as entry_count,
    0::bigint as total_stitches,
    fr.amount as total_base,
    0 as total_bonus, 0 as total_deduction, 0 as total_loan,
    fr.amount as total_net,
    not exists (
      select 1 from public.worker_ledger wl2
       where wl2.worker_id = fr.worker_id and wl2.period = (select val from v_period)
         and wl2.shift_id is null
    ) as has_pending,
    fr.salary_type
  from fixed_rows fr
  where fr.amount > 0
  order by display_name;
$$;

-- Finalize: keeps 0027's loan-capping, then posts fixed-salary rows for the
-- period (shift_id IS NULL marks them, so they're never mistaken for shift
-- earnings). Fixed-salary loans are not applied in this pass: their rows did
-- not exist when the loan step ran, which is a deliberate simplification.
create or replace function public.acct_finalize_salary_run(
  p_period     text default null,
  p_worker_ids uuid[] default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_period    text := coalesce(p_period, public.current_payroll_period());
  v_factory   uuid := public.current_factory_id();
  v_count     int;
  v_loans     int := 0;
  v_deferred  int := 0;
  v_fixed     int := 0;
  r           record;
  v_row       public.worker_ledger;
  v_available numeric;
  v_take      numeric;
  v_amount    numeric;
begin
  perform public.assert_role(array['accountant','company_admin']);
  perform public.assert_module('machine_workforce');

  -- 1. Loan installments, before the period is closed.
  for r in
    select l.*
    from public.loans l
    where l.factory_id = v_factory
      and l.status = 'active'
      and l.balance > 0
      and (l.starts_period is null or l.starts_period <= v_period)
      and (p_worker_ids is null or l.worker_id = any(p_worker_ids))
      and exists (
        select 1 from public.worker_ledger wl
         where wl.factory_id = v_factory and wl.worker_id = l.worker_id
           and wl.period = v_period and wl.status = 'pending'
      )
    order by l.created_at
  loop
    select greatest(
             coalesce(sum((wl.stitch_count * wl.base_per_stitch) + wl.bonus
                          - wl.damage_deduction - wl.loan_installment), 0),
             0)
      into v_available
      from public.worker_ledger wl
     where wl.factory_id = v_factory
       and wl.worker_id = r.worker_id
       and wl.period = v_period;

    v_take := least(r.installment_amount, r.balance, v_available);

    if v_take <= 0 then
      v_deferred := v_deferred + 1;
      continue;
    end if;

    v_row := public.open_ledger_row(r.worker_id, v_period);

    update public.worker_ledger
       set loan_installment = loan_installment + v_take
     where id = v_row.id;
    perform public.recompute_ledger_net(v_row.id);

    update public.loans
       set balance = balance - v_take,
           status = case when balance - v_take <= 0 then 'paid_off' else 'active' end
     where id = r.id;

    v_loans := v_loans + 1;
  end loop;

  -- 2. Fixed-salary employees: per_month flat, per_day = days worked x rate.
  for r in
    select ec.user_id, ec.salary_type, ec.salary_amount
    from public.employee_compensation ec
    where ec.factory_id = v_factory
      and ec.salary_type in ('per_day','per_month')
      and (p_worker_ids is null or ec.user_id = any(p_worker_ids))
      and not exists (
        select 1 from public.worker_ledger wl
         where wl.worker_id = ec.user_id and wl.factory_id = v_factory
           and wl.period = v_period and wl.shift_id is null
      )
  loop
    if r.salary_type = 'per_month' then
      v_amount := r.salary_amount;
    else
      select count(distinct wl.created_at::date) into v_amount
        from public.worker_ledger wl
       where wl.worker_id = r.user_id and wl.factory_id = v_factory
         and wl.period = v_period;
      v_amount := r.salary_amount * coalesce(v_amount, 0);
    end if;

    if v_amount <= 0 then continue; end if;

    insert into public.worker_ledger (
      factory_id, worker_id, shift_id, period, stitch_count, base_per_stitch,
      bonus, damage_deduction, loan_installment, net, status, finalized_at, finalized_by
    ) values (
      v_factory, r.user_id, null, v_period, 0, 0,
      0, 0, 0, v_amount, 'finalized', now(), auth.uid()
    );

    v_fixed := v_fixed + 1;
  end loop;

  -- 3. Close the period.
  update public.worker_ledger wl
     set status = 'finalized', finalized_at = now(), finalized_by = auth.uid()
   where wl.factory_id = v_factory
     and wl.period = v_period
     and wl.status = 'pending'
     and (p_worker_ids is null or wl.worker_id = any(p_worker_ids));

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'finalized_count', v_count,
    'fixed_salary_count', v_fixed,
    'loans_applied', v_loans,
    'loans_deferred', v_deferred,
    'period', v_period
  );
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.create_employee(text,text,text,text,text,numeric) to authenticated;
grant execute on function public.deactivate_employee(uuid) to authenticated;
grant execute on function public.master_client_stats() to authenticated;
grant execute on function public.master_supplier_stats() to authenticated;
grant execute on function public.master_machine_stats() to authenticated;
grant execute on function public.master_partner_stats() to authenticated;
grant execute on function public.acct_salary_run_summary(text) to authenticated;
grant execute on function public.acct_finalize_salary_run(text,uuid[]) to authenticated;
