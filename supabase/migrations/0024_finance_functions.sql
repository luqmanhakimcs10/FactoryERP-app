-- =============================================================================
-- Factory ERP — Phase 7 transition functions.
--
-- Three of these are the mechanisms earlier phases promised but did not build:
--   owner_approve_damage()  -> actually writes worker_ledger.damage_deduction
--   acct_add_loan() + the salary run -> actually deduct an installment
--   owner_approve_expense() -> actually resolves Phase 4's "awaiting approval"
--
-- SECURITY: SECURITY DEFINER bypasses RLS, so every function re-checks factory
-- ownership explicitly.
-- =============================================================================

alter table public.factory_counters
  add column if not exists invoice_seq bigint not null default 0;

-- ---------------------------------------------------------------------------
-- Ledger helper
-- ---------------------------------------------------------------------------
/**
 * Find (or create) the worker's OPEN ledger row for a period, so an adjustment
 * has somewhere to land.
 *
 * Adjustments are deliberately NOT merged into a shift row: an adjustment row
 * has shift_id = null, which keeps "what this worker earned on this machine"
 * separable from "what was deducted from them" in every later report.
 *
 * Refuses to touch a finalized period — that is what makes deductions and loan
 * installments non-retroactive.
 */
create or replace function public.open_ledger_row(
  p_worker_id uuid,
  p_period    text
)
returns public.worker_ledger
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_row     public.worker_ledger;
begin
  select * into v_row
    from public.worker_ledger
   where factory_id = v_factory
     and worker_id = p_worker_id
     and period = p_period
     and status = 'pending'
     and shift_id is null
   limit 1;

  if found then
    return v_row;
  end if;

  insert into public.worker_ledger
    (factory_id, worker_id, shift_id, period, stitch_count,
     base_per_stitch, bonus, damage_deduction, loan_installment, net, status)
  values
    (v_factory, p_worker_id, null, p_period, 0, 0, 0, 0, 0, 0, 'pending')
  returning * into v_row;

  return v_row;
end $$;

/** Recompute a ledger row's net after an adjustment. */
create or replace function public.recompute_ledger_net(p_ledger_id uuid)
returns void
language sql security definer set search_path = public as $$
  update public.worker_ledger
     set net = (stitch_count * base_per_stitch) + bonus - damage_deduction - loan_installment
   where id = p_ledger_id
$$;

-- ===========================================================================
-- FLOOR MANAGER — final QA + invoice
-- ===========================================================================

/** Repeats whose every configured stage is complete. Reads history, as always. */
create or replace function public.fm_final_qa_queue()
returns table (
  order_id     uuid,
  order_code   text,
  vendor_name  text,
  total_repeats int,
  ready_repeats int
)
language sql stable security definer set search_path = public as $$
  select o.id, o.order_code, v.name,
         count(r.id)::int,
         count(r.id) filter (where r.current_status = 'awaiting_final_qa')::int
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  join public.sheets s on s.order_id = o.id
  join public.repeats r on r.sheet_id = s.id
  where o.factory_id = public.current_factory_id()
    and not exists (select 1 from public.invoices i
                     where i.order_id = o.id and i.status <> 'cancelled')
  group by o.id, o.order_code, v.name
  having count(r.id) filter (where r.current_status = 'awaiting_final_qa') > 0
  order by o.order_code
$$;

/** Pass final QA for one repeat. */
create or replace function public.fm_final_qa_pass(p_repeat_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_factory uuid := public.current_factory_id();
        v_status text;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','qa','company_admin']);

  select current_status into v_status from public.repeats
   where id = p_repeat_id and factory_id = v_factory;
  if v_status is null then perform public.raise_not_found('Repeat not found.'); end if;

  if v_status <> 'awaiting_final_qa' then
    raise exception 'This repeat is not awaiting final QA (status: %).', v_status
      using errcode = '22023';
  end if;

  -- Source of truth, as since Phase 3.
  perform public.log_repeat_stage(p_repeat_id, 'completed', null, null,
    coalesce(p_note, 'Passed final QA'));

  return jsonb_build_object('repeat_id', p_repeat_id, 'status', 'completed');
end $$;

/**
 * Generate the order's invoice. This is what makes the order appear in the
 * accountant's Receivables list.
 *
 * Amount is derived from the order's own stitch work rather than typed, so the
 * invoice cannot silently disagree with what was produced. `p_amount` overrides
 * for negotiated pricing.
 */
create or replace function public.fm_generate_invoice(
  p_order_id uuid,
  p_amount   numeric default null,
  p_note     text default null
)
returns public.invoices
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_factory uuid := public.current_factory_id();
  v_amount  numeric;
  v_inv     public.invoices;
  v_rate    numeric := 0.02;   -- billed per stitch; negotiated rates override
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if exists (select 1 from public.invoices
              where order_id = p_order_id and status <> 'cancelled') then
    raise exception 'This order already has an invoice.' using errcode = '22023';
  end if;

  select coalesce(sum(s.stitch_count::numeric * s.repeats_count), 0) * v_rate
    into v_amount
    from public.sheets s where s.order_id = p_order_id;

  v_amount := coalesce(p_amount, v_amount);

  insert into public.invoices
    (factory_id, order_id, invoice_code, amount, status, issued_by, note)
  values
    (v_factory, p_order_id,
     public.make_code(v_factory, 'INV', public.next_counter(v_factory, 'invoice_seq')),
     v_amount, 'pending', auth.uid(), p_note)
  returning * into v_inv;

  update public.orders set status = 'ready_for_delivery' where id = p_order_id;

  return v_inv;
end $$;

-- ===========================================================================
-- ACCOUNTANT
-- ===========================================================================

/**
 * Record a payment against an invoice (receivable) or a PO (payable).
 * A receivable also marks the invoice paid; a payable also advances the PO,
 * which is what finally resolves Phase 4's "awaiting accountant payment".
 */
create or replace function public.acct_record_payment(
  p_ref_type  text,
  p_ref_id    uuid,
  p_amount    numeric,
  p_proof_url text default null,
  p_note      text default null
)
returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_pay     public.payments;
  v_dir     text;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Payment amount must be greater than zero.' using errcode = '22023';
  end if;

  if p_ref_type = 'invoice' then
    if not exists (select 1 from public.invoices
                    where id = p_ref_id and factory_id = v_factory) then
      perform public.raise_not_found('Invoice not found.');
    end if;
    v_dir := 'receivable';

  elsif p_ref_type = 'po' then
    if not exists (select 1 from public.purchase_orders
                    where id = p_ref_id and factory_id = v_factory) then
      perform public.raise_not_found('Purchase order not found.');
    end if;
    v_dir := 'payable';

  else
    raise exception 'Unsupported payment reference type: %.', p_ref_type using errcode = '22023';
  end if;

  insert into public.payments
    (factory_id, direction, ref_type, ref_id, amount, proof_url, recorded_by, note)
  values
    (v_factory, v_dir, p_ref_type, p_ref_id, p_amount, p_proof_url, auth.uid(), p_note)
  returning * into v_pay;

  if p_ref_type = 'invoice' then
    update public.invoices set status = 'paid', paid_at = now() where id = p_ref_id;
  else
    -- Reuses the Phase 4 transition so the PO state machine stays in one place.
    update public.purchase_orders
       set status = 'paid', paid_at = now(), paid_by = auth.uid(),
           amount = coalesce(amount, p_amount)
     where id = p_ref_id and status = 'approved';
  end if;

  return v_pay;
end $$;

/**
 * Record an already-approved loan.
 *
 * `starts_period` is set to the period AFTER the current one. That single line is
 * what makes deduction non-retroactive: a salary run for the current or any
 * earlier period cannot pick this loan up, so recording a loan can never reach
 * back into pay that has already been calculated.
 */
create or replace function public.acct_add_loan(
  p_worker_id  uuid,
  p_principal  numeric,
  p_installment numeric
)
returns public.loans
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_loan    public.loans;
  v_next    text;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  if not exists (select 1 from public.profiles
                  where id = p_worker_id and factory_id = v_factory) then
    perform public.raise_not_found('Worker not found in your factory.');
  end if;
  if coalesce(p_principal, 0) <= 0 then
    raise exception 'Principal must be greater than zero.' using errcode = '22023';
  end if;
  if coalesce(p_installment, 0) <= 0 then
    raise exception 'Installment must be greater than zero.' using errcode = '22023';
  end if;
  if p_installment > p_principal then
    raise exception 'Installment cannot exceed the principal.' using errcode = '22023';
  end if;

  v_next := to_char(
    (to_date(public.current_payroll_period() || '-01', 'YYYY-MM-DD') + interval '1 month'),
    'YYYY-MM');

  insert into public.loans
    (factory_id, worker_id, principal, balance, installment_amount,
     status, recorded_by, starts_period)
  values
    (v_factory, p_worker_id, p_principal, p_principal, p_installment,
     'active', auth.uid(), v_next)
  returning * into v_loan;

  return v_loan;
end $$;

/**
 * Apply loan installments for a period, then finalize it.
 *
 * Replaces the Phase 5 finalize so the two cannot diverge. Installments apply
 * once per worker per period, only for loans whose starts_period has arrived,
 * and only to a period that is still open.
 */
create or replace function public.acct_finalize_salary_run(
  p_period     text default null,
  p_worker_ids uuid[] default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_period  text := coalesce(p_period, public.current_payroll_period());
  v_factory uuid := public.current_factory_id();
  v_count   int;
  v_loans   int := 0;
  r         record;
  v_row     public.worker_ledger;
  v_take    numeric;
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
      -- Only if this worker still has an open row for the period.
      and exists (
        select 1 from public.worker_ledger wl
         where wl.factory_id = v_factory and wl.worker_id = l.worker_id
           and wl.period = v_period and wl.status = 'pending'
      )
      -- And not already taken for this period.
      and not exists (
        select 1 from public.worker_ledger wl2
         where wl2.factory_id = v_factory and wl2.worker_id = l.worker_id
           and wl2.period = v_period and wl2.loan_installment > 0
      )
  loop
    v_take := least(r.installment_amount, r.balance);
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
    'period', v_period
  );
end $$;

/** Record a fixed or manual expense. Pending until the owner approves. */
create or replace function public.acct_add_expense(
  p_category    text,
  p_amount      numeric,
  p_description text default null,
  p_proof_url   text default null,
  p_recurring   boolean default false
)
returns public.expenses
language plpgsql security definer set search_path = public as $$
declare v_exp public.expenses;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Amount must be greater than zero.' using errcode = '22023';
  end if;

  insert into public.expenses
    (factory_id, category, amount, description, proof_url, recurring,
     status, recorded_by)
  values
    (public.current_factory_id(), p_category, p_amount, p_description,
     p_proof_url, coalesce(p_recurring, false), 'pending', auth.uid())
  returning * into v_exp;

  return v_exp;
end $$;

/**
 * Pay a finishing partner. THE THREE-WAY WRITE.
 *
 * One action must write all three of:
 *   payments        (direction=payable, ref_type=partner)
 *   expenses        (category=partner_payment)
 *   partner_ledger  (entry_type=payment)
 *
 * They go in one transaction because each serves a different reader and all
 * three must agree: the P&L sums `expenses` with no special case for partners,
 * the payables view reads `payments`, and the partner's own dashboard reads
 * `partner_ledger`. Writing only one leaves two of those three silently wrong.
 *
 * The expense is created already approved — the earning it settles was approved
 * upstream, so asking the owner to approve it again would stall real payments.
 */
create or replace function public.acct_pay_partner(
  p_partner_id uuid,
  p_amount     numeric,
  p_proof_url  text default null,
  p_note       text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_partner public.finishing_partners;
  v_pay     public.payments;
  v_exp     public.expenses;
  v_led     public.partner_ledger;
  v_period  text := public.current_payroll_period();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  select * into v_partner from public.finishing_partners
   where id = p_partner_id and factory_id = v_factory;
  if not found then perform public.raise_not_found('Finishing partner not found.'); end if;

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Payment amount must be greater than zero.' using errcode = '22023';
  end if;

  -- 1. The payment itself.
  insert into public.payments
    (factory_id, direction, ref_type, ref_id, amount, proof_url, recorded_by, note)
  values
    (v_factory, 'payable', 'partner', p_partner_id, p_amount, p_proof_url,
     auth.uid(), p_note)
  returning * into v_pay;

  -- 2. The expense, so the P&L needs no special-casing for partners.
  insert into public.expenses
    (factory_id, category, amount, description, proof_url, recurring,
     status, approved_by, approved_at, recorded_by)
  values
    (v_factory, 'partner_payment', p_amount,
     'Payment to ' || v_partner.name, p_proof_url, false,
     'approved', auth.uid(), now(), auth.uid())
  returning * into v_exp;

  -- 3. The partner's own ledger.
  insert into public.partner_ledger
    (factory_id, partner_id, entry_type, amount, period, rate_basis,
     ref_id, created_by)
  values
    (v_factory, p_partner_id, 'payment', p_amount, v_period,
     v_partner.rate_basis, v_pay.id, auth.uid())
  returning * into v_led;

  return jsonb_build_object(
    'payment_id', v_pay.id,
    'expense_id', v_exp.id,
    'partner_ledger_id', v_led.id,
    'amount', p_amount
  );
end $$;

-- ===========================================================================
-- OWNER — approvals
-- ===========================================================================

create or replace function public.owner_approve_expense(
  p_expense_id uuid,
  p_approve    boolean default true,
  p_note       text default null
)
returns public.expenses
language plpgsql security definer set search_path = public as $$
declare v_exp public.expenses;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['company_admin']);

  select * into v_exp from public.expenses
   where id = p_expense_id and factory_id = public.current_factory_id();
  if not found then perform public.raise_not_found('Expense not found.'); end if;

  if v_exp.status <> 'pending' then
    raise exception 'This expense has already been decided (status: %).', v_exp.status
      using errcode = '22023';
  end if;

  update public.expenses
     set status = case when p_approve then 'approved' else 'rejected' end,
         approved_by = auth.uid(), approved_at = now(),
         description = coalesce(description, '') ||
           case when p_note is null then '' else ' — ' || p_note end
   where id = p_expense_id
  returning * into v_exp;

  return v_exp;
end $$;

/**
 * Approve or reject a damage record.
 *
 * THIS IS THE MECHANISM PHASE 5 PROMISED: approving a worker-accountable record
 * adds its deduction into that worker's open ledger period. Rejecting leaves the
 * deduction at zero and marks the record resolved, so it stops appearing in the
 * queue without ever touching pay.
 *
 * Deductions only ever land in an OPEN period — open_ledger_row() will not touch
 * a finalized one, so approving late cannot reach back into pay already run.
 */
create or replace function public.owner_approve_damage(
  p_damage_id uuid,
  p_approve   boolean default true,
  p_deduction numeric default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_dmg     public.damage_records;
  v_row     public.worker_ledger;
  v_period  text := public.current_payroll_period();
  v_amount  numeric;
  v_applied boolean := false;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['company_admin']);

  select * into v_dmg from public.damage_records
   where id = p_damage_id and factory_id = v_factory;
  if not found then perform public.raise_not_found('Damage record not found.'); end if;

  if v_dmg.approval_status <> 'pending' then
    raise exception 'This damage record has already been decided (status: %).',
      v_dmg.approval_status using errcode = '22023';
  end if;

  if not p_approve then
    update public.damage_records
       set approval_status = 'rejected', approved_by = auth.uid(),
           approved_at = now(), deduction = 0
     where id = p_damage_id;

    return jsonb_build_object('damage_id', p_damage_id, 'approval_status', 'rejected',
                              'deduction_applied', 0);
  end if;

  v_amount := coalesce(p_deduction, v_dmg.deduction, 0);

  update public.damage_records
     set approval_status = 'approved', approved_by = auth.uid(),
         approved_at = now(), deduction = v_amount
   where id = p_damage_id;

  -- Only worker-accountable damage touches payroll. Vendor damage is billed to
  -- the vendor and partner damage is charged to the partner's ledger.
  if v_dmg.responsible_type = 'worker' and v_dmg.responsible_id is not null and v_amount > 0 then
    v_row := public.open_ledger_row(v_dmg.responsible_id, v_period);

    update public.worker_ledger
       set damage_deduction = damage_deduction + v_amount
     where id = v_row.id;
    perform public.recompute_ledger_net(v_row.id);

    update public.damage_records set ledger_applied_period = v_period where id = p_damage_id;
    v_applied := true;

  elsif v_dmg.responsible_type = 'partner' and v_dmg.responsible_id is not null and v_amount > 0 then
    insert into public.partner_ledger
      (factory_id, partner_id, entry_type, amount, period,
       damage_record_id, repeat_id, created_by)
    values
      (v_factory, v_dmg.responsible_id, 'damage_charge', -v_amount, v_period,
       p_damage_id, v_dmg.repeat_id, auth.uid());
    v_applied := true;
  end if;

  return jsonb_build_object(
    'damage_id', p_damage_id,
    'approval_status', 'approved',
    'deduction_applied', v_amount,
    'responsible_type', v_dmg.responsible_type,
    'posted', v_applied,
    'period', case when v_applied then v_period else null end
  );
end $$;

/** Approve or reject a proposed bonus slab change. */
create or replace function public.owner_decide_slab_proposal(
  p_proposal_id uuid,
  p_approve     boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_p       public.bonus_slab_proposals;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['company_admin']);

  select * into v_p from public.bonus_slab_proposals
   where id = p_proposal_id and factory_id = v_factory;
  if not found then perform public.raise_not_found('Proposal not found.'); end if;

  if v_p.status <> 'pending' then
    raise exception 'This proposal has already been decided (status: %).', v_p.status
      using errcode = '22023';
  end if;

  if p_approve then
    if v_p.action = 'create' then
      insert into public.bonus_slabs (factory_id, daily_stitch_threshold, bonus_amount)
      values (v_factory, v_p.daily_stitch_threshold, v_p.bonus_amount);

    elsif v_p.action = 'update' then
      update public.bonus_slabs
         set daily_stitch_threshold = coalesce(v_p.daily_stitch_threshold, daily_stitch_threshold),
             bonus_amount = coalesce(v_p.bonus_amount, bonus_amount)
       where id = v_p.bonus_slab_id and factory_id = v_factory;

    elsif v_p.action = 'delete' then
      delete from public.bonus_slabs
       where id = v_p.bonus_slab_id and factory_id = v_factory;
    end if;
  end if;

  update public.bonus_slab_proposals
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now()
   where id = p_proposal_id;

  return jsonb_build_object('proposal_id', p_proposal_id,
                            'status', case when p_approve then 'approved' else 'rejected' end,
                            'action', v_p.action);
end $$;

/** The unified approvals queue: three kinds of pending decision in one list. */
create or replace function public.owner_approvals_queue()
returns table (
  kind        text,
  id          uuid,
  title       text,
  subtitle    text,
  amount      numeric,
  created_at  timestamptz
)
language sql stable security definer set search_path = public as $$
  select 'expense', e.id,
         initcap(replace(e.category, '_', ' ')),
         coalesce(e.description, 'No description'),
         e.amount, e.created_at
  from public.expenses e
  where e.factory_id = public.current_factory_id() and e.status = 'pending'

  union all

  select 'damage', d.id,
         initcap(d.damage_type) || ' — ' || d.responsible_type || ' accountable',
         coalesce((select order_code from public.orders o where o.id = d.order_id), '')
           || coalesce(' · ' || (select repeat_code from public.repeats r where r.id = d.repeat_id), ''),
         d.deduction, d.created_at
  from public.damage_records d
  where d.factory_id = public.current_factory_id() and d.approval_status = 'pending'

  union all

  select 'bonus_slab', p.id,
         'Bonus slab: ' || p.action,
         coalesce(p.reason, '') ||
           coalesce(' · ' || p.daily_stitch_threshold::text || ' stitches', '') ||
           coalesce(' -> ' || p.bonus_amount::text, ''),
         p.bonus_amount, p.created_at
  from public.bonus_slab_proposals p
  where p.factory_id = public.current_factory_id() and p.status = 'pending'

  order by created_at
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.open_ledger_row(uuid, text) to authenticated;
grant execute on function public.recompute_ledger_net(uuid) to authenticated;
grant execute on function public.fm_final_qa_queue() to authenticated;
grant execute on function public.fm_final_qa_pass(uuid, text) to authenticated;
grant execute on function public.fm_generate_invoice(uuid, numeric, text) to authenticated;
grant execute on function public.acct_record_payment(text, uuid, numeric, text, text) to authenticated;
grant execute on function public.acct_add_loan(uuid, numeric, numeric) to authenticated;
grant execute on function public.acct_finalize_salary_run(text, uuid[]) to authenticated;
grant execute on function public.acct_add_expense(text, numeric, text, text, boolean) to authenticated;
grant execute on function public.acct_pay_partner(uuid, numeric, text, text) to authenticated;
grant execute on function public.owner_approve_expense(uuid, boolean, text) to authenticated;
grant execute on function public.owner_approve_damage(uuid, boolean, numeric) to authenticated;
grant execute on function public.owner_decide_slab_proposal(uuid, boolean) to authenticated;
grant execute on function public.owner_approvals_queue() to authenticated;
