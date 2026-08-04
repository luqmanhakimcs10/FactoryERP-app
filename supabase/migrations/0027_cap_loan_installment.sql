-- =============================================================================
-- Factory ERP — never deduct a loan installment beyond what a worker earned.
--
-- BUG surfaced during Phase 7 verification: a worker with two active loans in a
-- period where they had earned little ended with net = -2000. Deducting more
-- than someone earned produces negative pay, which is not a real payroll
-- outcome — the shortfall should simply stay on the loan and come out of a later
-- period.
--
-- Fix: cap each installment at the earnings still available in that period
-- (gross + bonus, less damage deductions and installments already taken). A
-- capped installment reduces the loan balance by only what was actually taken,
-- so nothing is lost — the remainder is collected next period.
-- =============================================================================

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
  r           record;
  v_row       public.worker_ledger;
  v_available numeric;
  v_take      numeric;
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
    order by l.created_at            -- oldest loan gets first claim on the pay
  loop
    -- What is left to take from this period, across ALL of the worker's rows.
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
      -- Nothing left to take: the loan simply waits for a period with earnings.
      v_deferred := v_deferred + 1;
      continue;
    end if;

    v_row := public.open_ledger_row(r.worker_id, v_period);

    update public.worker_ledger
       set loan_installment = loan_installment + v_take
     where id = v_row.id;
    perform public.recompute_ledger_net(v_row.id);

    -- Balance falls by what was ACTUALLY taken, so a capped installment leaves
    -- the remainder owing rather than quietly forgiving it.
    update public.loans
       set balance = balance - v_take,
           status = case when balance - v_take <= 0 then 'paid_off' else 'active' end
     where id = r.id;

    v_loans := v_loans + 1;
  end loop;

  -- 2. Close the period.
  update public.worker_ledger wl
     set status = 'finalized', finalized_at = now(), finalized_by = auth.uid()
   where wl.factory_id = v_factory
     and wl.period = v_period
     and wl.status = 'pending'
     and (p_worker_ids is null or wl.worker_id = any(p_worker_ids));

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'finalized_count', v_count,
    'loans_applied', v_loans,
    'loans_deferred', v_deferred,
    'period', v_period
  );
end $$;

grant execute on function public.acct_finalize_salary_run(text, uuid[]) to authenticated;

-- Repair the row the bug produced, and hand the over-taken amount back to the
-- loans it came from, oldest first.
do $$
declare
  r        record;
  v_excess numeric;
  v_loan   uuid;
begin
  for r in
    select wl.id, wl.worker_id, wl.period, wl.loan_installment,
           (wl.stitch_count * wl.base_per_stitch) + wl.bonus - wl.damage_deduction as earned
    from public.worker_ledger wl
    where wl.net < 0
  loop
    v_excess := least(r.loan_installment, -( r.earned - r.loan_installment ));
    if v_excess <= 0 then continue; end if;

    update public.worker_ledger
       set loan_installment = greatest(loan_installment - v_excess, 0)
     where id = r.id;
    perform public.recompute_ledger_net(r.id);

    -- Hand the over-taken amount back to the most recent loan it came from.
    select l.id into v_loan
      from public.loans l
     where l.worker_id = r.worker_id
     order by l.created_at desc
     limit 1;

    if v_loan is not null then
      update public.loans
         set balance = balance + v_excess, status = 'active'
       where id = v_loan;
    end if;
  end loop;
end $$;
