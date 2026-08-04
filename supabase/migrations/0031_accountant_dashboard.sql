-- =============================================================================
-- Factory ERP — Accountant Dashboard: 6 boxes + Invoices (receivable/payable)
--
-- Three things land here:
--
--   1. TWO NEW COLUMNS, NOT NEW TABLES. Every box on the accountant's dashboard
--      reads data that already exists (vendors, suppliers, finishing_partners,
--      employee_compensation, worker_ledger, leaves, machines, shifts,
--      purchase_orders, partner_ledger, damage_records). Only two facts were
--      missing: an invoice's photo + due date, and the free-text bill subtype
--      that makes "add a new bill type" work without an enum to edit.
--
--   2. PHOTO IS NOW MANDATORY WHEREVER MONEY IS RECORDED. Enforced inside the
--      posting RPCs rather than as a CHECK constraint: even a NOT VALID check
--      fires on UPDATE of the pre-existing photo-less rows, so marking a seeded
--      invoice paid would start failing. Raising inside the function stops every
--      new record — old screens included, since they all post through these same
--      functions — while leaving history readable and updatable.
--
--   3. READ RPCs FOR THE SIX BOXES. Same pattern as 0030's master_*_stats:
--      SECURITY DEFINER aggregates over the transaction tables, never a copy,
--      always scoped to current_factory_id(). Unlike 0030's, each one asserts its
--      module and role: SECURITY DEFINER bypasses RLS, so the policy's module
--      gate has to be restated in the function or it is simply gone.
--
-- Module gating is deliberate: the money boxes assert finance_reports, the
-- people/machine boxes assert machine_workforce. A factory with those modules
-- off (Beta, in the dev seed) gets the standard disabled message rather than
-- half-populated figures.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

-- Invoices: the photo is the proof the invoice was actually issued; the due date
-- is what "next pay date" on a client reads.
alter table public.invoices
  add column if not exists photo_url text,
  add column if not exists due_date  date;

-- Pre-existing invoices have no due date. Default them to 30 days after issue so
-- the receivable summary reconciles against a date instead of nulls.
update public.invoices
   set due_date = ((issued_at at time zone 'UTC')::date + 30)
 where due_date is null;

create index if not exists idx_invoices_due
  on public.invoices(factory_id, due_date) where status = 'pending';

-- Expenses: `bills` joins the category list, and bill_subtype holds the name the
-- user typed ("electricity", "internet", anything). THIS is how a new bill type
-- is added — free text, with prior values suggested back. No enum, no admin
-- screen, nothing to migrate when a factory invents a new kind of bill.
alter table public.expenses
  add column if not exists bill_subtype text;

-- The category CHECK was declared inline in 0023, so its name is whatever
-- Postgres generated. Drop by definition rather than by guessed name — dropping
-- the wrong name silently leaves the old constraint in place and 'bills' would
-- keep being rejected.
do $$
declare c text;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'expenses'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%category%'
  loop
    execute format('alter table public.expenses drop constraint %I', c);
  end loop;
end $$;

alter table public.expenses add constraint expenses_category_check
  check (category in
    ('rent','utilities','maintenance','partner_payment','materials','bills','other'));

create index if not exists idx_expenses_bill_subtype
  on public.expenses(factory_id, bill_subtype) where bill_subtype is not null;

-- Damage quantity. The Finishing Partner detail panel reports a damage quantity
-- and its query selects `quantity_meters`, but no column ever held it — so that
-- panel errored out. Added with a 0 default so the screen reads cleanly and
-- damage capture can start recording a real figure.
alter table public.damage_records
  add column if not exists quantity_meters numeric(14,2) not null default 0;

alter table public.damage_records drop constraint if exists damage_quantity_meters_chk;
alter table public.damage_records add constraint damage_quantity_meters_chk
  check (quantity_meters >= 0);

-- ---------------------------------------------------------------------------
-- 2. leaves
--
-- Declared in 0022 (Phase 8), which is not applied on every project. Recreated
-- here `if not exists` with the identical shape so whichever ran first wins, and
-- the select policy is rewritten to include the accountant — the Employees box
-- shows leaves, and the accountant was not on 0022's reader list.
-- ---------------------------------------------------------------------------
create table if not exists public.leaves (
  id            uuid primary key default gen_random_uuid(),
  factory_id    uuid not null default public.current_factory_id()
                  references public.factories(id) on delete cascade,
  worker_id     uuid not null references public.profiles(id) on delete restrict,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  reason        text not null,
  start_date    date not null,
  end_date      date not null,
  requested_at  timestamptz not null default now(),
  approved_by   uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_leaves_factory_worker
  on public.leaves(factory_id, worker_id, requested_at desc);

alter table public.leaves enable row level security;

drop policy if exists leaves_select on public.leaves;
create policy leaves_select on public.leaves
  for select to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and (
      public.has_any_role(array['floor_manager','company_admin','accountant'])
      or worker_id = auth.uid()
    )
  );

drop policy if exists leaves_insert on public.leaves;
create policy leaves_insert on public.leaves
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and worker_id = auth.uid()
    and public.current_user_role() = 'worker'
  );

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
-- 3. Shared guards
-- ---------------------------------------------------------------------------

/**
 * One place to state the photo rule, so every posting function refuses
 * identically and the message reads the same wherever it surfaces.
 */
create or replace function public.assert_proof_photo(p_url text, p_what text)
returns void
language plpgsql immutable as $$
begin
  if coalesce(trim(p_url), '') = '' then
    raise exception '% requires a photo. Attach the bill, receipt or transfer proof before saving.', p_what
      using errcode = '22023';
  end if;
end $$;

/** Nth day of the month containing p_month, clamped to that month's length. */
create or replace function public.billing_day_of_month(p_month date, p_day int)
returns date
language sql immutable as $$
  select date_trunc('month', p_month)::date
       + (least(
            greatest(p_day, 1),
            extract(day from (date_trunc('month', p_month) + interval '1 month - 1 day'))::int
          ) - 1);
$$;

-- ---------------------------------------------------------------------------
-- 4. Photo required wherever money is recorded
-- ---------------------------------------------------------------------------

-- Invoice generation: the old 3-argument form must go, or a caller could keep
-- raising photo-less invoices through the surviving overload.
drop function if exists public.fm_generate_invoice(uuid, numeric, text);

create or replace function public.fm_generate_invoice(
  p_order_id  uuid,
  p_amount    numeric default null,
  p_note      text default null,
  p_photo_url text default null,
  p_due_date  date default null
)
returns public.invoices
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_factory uuid := public.current_factory_id();
  v_amount  numeric;
  v_inv     public.invoices;
  v_rate    numeric := 0.02;   -- billed per stitch; negotiated rates override
  v_open    int;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_proof_photo(p_photo_url, 'An invoice');
  v_order := public.assert_my_order(p_order_id);

  if exists (select 1 from public.invoices
              where order_id = p_order_id and status <> 'cancelled') then
    raise exception 'This order already has an invoice.' using errcode = '22023';
  end if;

  -- Every repeat must have cleared final QA (unchanged from 0026).
  select count(*) into v_open
    from public.repeats r
    join public.sheets s on s.id = r.sheet_id
   where s.order_id = p_order_id
     and r.current_status <> 'completed';

  if v_open > 0 then
    raise exception
      'Cannot invoice yet: % repeat(s) have not passed final QA.', v_open
      using errcode = '22023';
  end if;

  select coalesce(sum(s.stitch_count::numeric * s.repeats_count), 0) * v_rate
    into v_amount
    from public.sheets s where s.order_id = p_order_id;

  v_amount := coalesce(p_amount, v_amount);

  insert into public.invoices
    (factory_id, order_id, invoice_code, amount, status, issued_by, note,
     photo_url, due_date)
  values
    (v_factory, p_order_id,
     public.make_code(v_factory, 'INV', public.next_counter(v_factory, 'invoice_seq')),
     v_amount, 'pending', auth.uid(), p_note,
     trim(p_photo_url), coalesce(p_due_date, current_date + 30))
  returning * into v_inv;

  update public.orders set status = 'ready_for_delivery' where id = p_order_id;

  return v_inv;
end $$;

-- Payments, both directions.
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
  perform public.assert_proof_photo(p_proof_url, 'A payment');

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
    (v_factory, v_dir, p_ref_type, p_ref_id, p_amount, trim(p_proof_url), auth.uid(), p_note)
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

-- Expenses: proof required, plus the free-text bill subtype. The old 5-argument
-- form is dropped so nothing can post an expense without a photo.
drop function if exists public.acct_add_expense(text, numeric, text, text, boolean);

create or replace function public.acct_add_expense(
  p_category     text,
  p_amount       numeric,
  p_description  text default null,
  p_proof_url    text default null,
  p_recurring    boolean default false,
  p_bill_subtype text default null
)
returns public.expenses
language plpgsql security definer set search_path = public as $$
declare
  v_exp     public.expenses;
  v_subtype text := nullif(trim(coalesce(p_bill_subtype, '')), '');
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);
  perform public.assert_proof_photo(p_proof_url, 'An expense');

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Amount must be greater than zero.' using errcode = '22023';
  end if;

  -- A bill has to say what kind of bill it is; that name IS the bill type.
  if p_category = 'bills' and v_subtype is null then
    raise exception 'Name the bill type (e.g. electricity) before saving.' using errcode = '22023';
  end if;
  if p_category <> 'bills' then
    v_subtype := null;
  end if;

  insert into public.expenses
    (factory_id, category, amount, description, proof_url, recurring,
     status, recorded_by, bill_subtype)
  values
    (public.current_factory_id(), p_category, p_amount, p_description,
     trim(p_proof_url), coalesce(p_recurring, false), 'pending', auth.uid(), v_subtype)
  returning * into v_exp;

  return v_exp;
end $$;

-- Partner payment: the three-way write, now also refusing without proof. The
-- body is otherwise 0024's, unchanged — all three inserts stay in one call.
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
  perform public.assert_proof_photo(p_proof_url, 'A partner payment');

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
    (v_factory, 'payable', 'partner', p_partner_id, p_amount, trim(p_proof_url),
     auth.uid(), p_note)
  returning * into v_pay;

  -- 2. The expense, so the P&L needs no special-casing for partners.
  insert into public.expenses
    (factory_id, category, amount, description, proof_url, recurring,
     status, approved_by, approved_at, recorded_by)
  values
    (v_factory, 'partner_payment', p_amount,
     'Payment to ' || v_partner.name, trim(p_proof_url), false,
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
-- 5. Box 1 — Clients (the vendors table, relabelled)
-- ===========================================================================

/**
 * One row per client with the receivable facts the accountant reconciles:
 * billed, received (payments against this client's invoices), pending, and the
 * earliest unpaid due date — the "next pay date".
 */
create or replace function public.acct_client_summary()
returns table (
  vendor_id        uuid,
  name             text,
  contact          text,
  address          text,
  rate_per_repeat  numeric,
  rate_per_stitch  numeric,
  price            numeric,
  invoice_count    int,
  unpaid_count     int,
  total_income     numeric,
  received         numeric,
  pending          numeric,
  next_due_date    date,
  damage_count     int,
  damage_deduction numeric
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  with inv as (
    select o.vendor_id as vid, i.id as iid, i.amount, i.status, i.due_date
      from public.invoices i
      join public.orders o on o.id = i.order_id
     where i.factory_id = v_factory and i.status <> 'cancelled'
  ),
  paid as (
    select inv.vid, coalesce(sum(p.amount), 0) as received
      from public.payments p
      join inv on inv.iid = p.ref_id
     where p.factory_id = v_factory
       and p.direction = 'receivable' and p.ref_type = 'invoice'
     group by inv.vid
  ),
  dmg as (
    select d.responsible_id as vid,
           count(*)::int as damage_count,
           coalesce(sum(d.deduction), 0) as damage_deduction
      from public.damage_records d
     where d.factory_id = v_factory
       and d.responsible_type = 'vendor'
       and d.approval_status <> 'rejected'
     group by d.responsible_id
  )
  select
    v.id, v.name, v.contact, v.address,
    v.rate_per_repeat, v.rate_per_stitch, v.price,
    count(inv.iid)::int,
    count(inv.iid) filter (where inv.status <> 'paid')::int,
    coalesce(sum(inv.amount), 0),
    coalesce(max(paid.received), 0),
    coalesce(sum(inv.amount) filter (where inv.status <> 'paid'), 0),
    min(inv.due_date) filter (where inv.status <> 'paid'),
    coalesce(max(dmg.damage_count), 0),
    coalesce(max(dmg.damage_deduction), 0)
  from public.vendors v
  left join inv  on inv.vid  = v.id
  left join paid on paid.vid = v.id
  left join dmg  on dmg.vid  = v.id
  where v.factory_id = v_factory and v.deleted_at is null
  group by v.id, v.name, v.contact, v.address,
           v.rate_per_repeat, v.rate_per_stitch, v.price
  order by v.name;
end $$;

/** This client's invoices — status, required photo, and what has been paid. */
create or replace function public.acct_client_invoices(p_vendor_id uuid)
returns table (
  invoice_id   uuid,
  invoice_code text,
  order_code   text,
  amount       numeric,
  status       text,
  photo_url    text,
  due_date     date,
  issued_at    timestamptz,
  paid_at      timestamptz,
  paid_amount  numeric,
  is_overdue   boolean
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select
    i.id, i.invoice_code, o.order_code, i.amount, i.status, i.photo_url,
    i.due_date, i.issued_at, i.paid_at,
    coalesce((
      select sum(p.amount) from public.payments p
       where p.ref_type = 'invoice' and p.ref_id = i.id
         and p.direction = 'receivable'
    ), 0),
    (i.status <> 'paid' and i.due_date is not null and i.due_date < current_date)
  from public.invoices i
  join public.orders o on o.id = i.order_id
  where i.factory_id = v_factory
    and o.vendor_id = p_vendor_id
    and i.status <> 'cancelled'
  order by i.issued_at desc;
end $$;

/** Damage this client is accountable for. */
create or replace function public.acct_client_damages(p_vendor_id uuid)
returns table (
  damage_id       uuid,
  order_code      text,
  stage_type      text,
  damage_type     text,
  deduction       numeric,
  quantity_meters numeric,
  approval_status text,
  photo_url       text,
  note            text,
  created_at      timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select d.id, o.order_code, d.stage_type, d.damage_type, d.deduction,
         d.quantity_meters, d.approval_status, d.photo_url, d.note, d.created_at
  from public.damage_records d
  join public.orders o on o.id = d.order_id
  where d.factory_id = v_factory
    and d.responsible_type = 'vendor'
    and d.responsible_id = p_vendor_id
  order by d.created_at desc;
end $$;

-- ===========================================================================
-- 6. Box 2 — Suppliers
-- ===========================================================================

/**
 * Next billing date comes from `payment_day` when the supplier has one — those
 * are the agreed terms and the only date the data states directly. Without one
 * it falls back to the oldest unpaid PO + 30 days, so a supplier on no agreed
 * terms still shows a date that can be traced to a record.
 */
create or replace function public.acct_supplier_summary()
returns table (
  supplier_id       uuid,
  name              text,
  contact           text,
  address           text,
  payment_day       int,
  po_count          int,
  unpaid_po_count   int,
  po_value          numeric,
  paid              numeric,
  outstanding       numeric,
  next_billing_date date
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  with po as (
    select p.id as pid, p.supplier_id as sid, p.amount, p.status, p.created_at
      from public.purchase_orders p
     where p.factory_id = v_factory and p.status <> 'cancelled'
  ),
  pay as (
    select po.sid, coalesce(sum(pm.amount), 0) as paid
      from public.payments pm
      join po on po.pid = pm.ref_id
     where pm.factory_id = v_factory
       and pm.direction = 'payable' and pm.ref_type = 'po'
     group by po.sid
  ),
  agg as (
    select
      s.id as sid, s.name as sname, s.contact as scontact, s.address as saddress,
      s.payment_day as spayment_day,
      count(po.pid)::int as po_count,
      count(po.pid) filter (where po.status not in ('paid','received'))::int as unpaid_po_count,
      coalesce(sum(po.amount), 0) as po_value,
      coalesce(max(pay.paid), 0) as paid,
      min(po.created_at) filter (where po.status not in ('paid','received')) as oldest_unpaid
    from public.suppliers s
    left join po  on po.sid  = s.id
    left join pay on pay.sid = s.id
    where s.factory_id = v_factory and s.deleted_at is null
    group by s.id, s.name, s.contact, s.address, s.payment_day
  )
  select
    agg.sid, agg.sname, agg.scontact, agg.saddress, agg.spayment_day,
    agg.po_count, agg.unpaid_po_count, agg.po_value, agg.paid,
    greatest(agg.po_value - agg.paid, 0),
    case
      when agg.spayment_day is not null then
        case
          when agg.spayment_day >= extract(day from current_date)::int
            then public.billing_day_of_month(current_date, agg.spayment_day)
          else public.billing_day_of_month(
                 (date_trunc('month', current_date) + interval '1 month')::date,
                 agg.spayment_day)
        end
      when agg.oldest_unpaid is not null
        then (agg.oldest_unpaid at time zone 'UTC')::date + 30
      else null
    end
  from agg
  order by agg.sname;
end $$;

/** A supplier's POs: completion status, value, and quantity from its line items. */
create or replace function public.acct_supplier_pos(p_supplier_id uuid)
returns table (
  po_id           uuid,
  po_code         text,
  status          text,
  amount          numeric,
  quantity_meters numeric,
  item_count      int,
  created_at      timestamptz,
  paid_at         timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select p.id, p.po_code, p.status, p.amount,
         coalesce((select sum(i.quantity_meters) from public.po_items i
                    where i.purchase_order_id = p.id), 0),
         coalesce((select count(*)::int from public.po_items i
                    where i.purchase_order_id = p.id), 0),
         p.created_at, p.paid_at
  from public.purchase_orders p
  where p.factory_id = v_factory and p.supplier_id = p_supplier_id
  order by p.created_at desc;
end $$;

-- ===========================================================================
-- 7. Box 4 — Employees (every role, not just workers)
-- ===========================================================================

/**
 * One row per employee, whatever their role.
 *
 * total_salary uses the SAME per-salary_type logic as the salary run (0030):
 *   per_stitch -> the period's worker_ledger net
 *   per_day    -> daily rate x distinct days with a ledger entry
 *   per_month  -> the flat salary
 * Bonus and fine read worker_ledger regardless of pay type, and are simply 0 for
 * roles that never earn a stitch bonus. next_pay_date is the start of the next
 * payroll period, since periods are calendar months (current_payroll_period).
 *
 * company_admin, super_admin and finishing_partner are excluded: the first two
 * are not paid staff and the third is a contractor with its own box and its own
 * ledger.
 */
create or replace function public.acct_employee_summary(p_period text default null)
returns table (
  user_id        uuid,
  display_name   text,
  contact        text,
  role           text,
  is_active      boolean,
  salary_type    text,
  salary_amount  numeric,
  period         text,
  days_worked    int,
  stitches       bigint,
  bonus          numeric,
  fine           numeric,
  loan_deducted  numeric,
  leave_requests int,
  leave_days     int,
  total_salary   numeric,
  next_pay_date  date
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_factory uuid := public.current_factory_id();
  v_period  text := coalesce(p_period, public.current_payroll_period());
  v_start   date := to_date(coalesce(p_period, public.current_payroll_period()) || '-01', 'YYYY-MM-DD');
  v_end     date;
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['accountant','company_admin']);

  v_end := (v_start + interval '1 month - 1 day')::date;

  return query
  with led as (
    select wl.worker_id as wid,
           count(distinct wl.created_at::date)::int as days_worked,
           coalesce(sum(wl.stitch_count), 0)::bigint as stitches,
           coalesce(sum(wl.bonus), 0) as bonus,
           coalesce(sum(wl.damage_deduction), 0) as fine,
           coalesce(sum(wl.loan_installment), 0) as loan_deducted,
           coalesce(sum(wl.net), 0) as net
      from public.worker_ledger wl
     where wl.factory_id = v_factory and wl.period = v_period
     group by wl.worker_id
  ),
  lv as (
    select l.worker_id as wid,
           count(*)::int as leave_requests,
           coalesce(sum(
             case when l.status = 'approved'
               then greatest((least(l.end_date, v_end) - greatest(l.start_date, v_start)) + 1, 0)
               else 0 end
           ), 0)::int as leave_days
      from public.leaves l
     where l.factory_id = v_factory
       and l.start_date <= v_end
       and l.end_date >= v_start
     group by l.worker_id
  )
  select
    p.id,
    p.display_name,
    u.email::text,
    p.role,
    p.is_active,
    coalesce(ec.salary_type, 'per_stitch'),
    coalesce(ec.salary_amount, p.stitch_rate, 0),
    v_period,
    coalesce(led.days_worked, 0),
    coalesce(led.stitches, 0::bigint),
    coalesce(led.bonus, 0),
    coalesce(led.fine, 0),
    coalesce(led.loan_deducted, 0),
    coalesce(lv.leave_requests, 0),
    coalesce(lv.leave_days, 0),
    case coalesce(ec.salary_type, 'per_stitch')
      when 'per_month' then coalesce(ec.salary_amount, 0)
      when 'per_day'   then coalesce(ec.salary_amount, 0) * coalesce(led.days_worked, 0)
      else coalesce(led.net, 0)
    end,
    (date_trunc('month', v_start) + interval '1 month')::date
  from public.profiles p
  left join public.employee_compensation ec
         on ec.user_id = p.id and ec.factory_id = v_factory
  left join led on led.wid = p.id
  left join lv  on lv.wid  = p.id
  left join auth.users u on u.id = p.id
  where p.factory_id = v_factory
    and p.role not in ('super_admin','company_admin','finishing_partner')
  order by p.display_name;
end $$;

-- ===========================================================================
-- 8. Box 5 — Machines
-- ===========================================================================

/**
 * Total hours = the sum of (closed_at - opened_at) over that machine's CLOSED
 * shifts. Open shifts are counted separately rather than accrued to now(), so
 * the figure reconciles exactly against the shift records instead of drifting
 * between two loads of the same screen.
 */
create or replace function public.acct_machine_summary()
returns table (
  machine_id    uuid,
  name          text,
  machine_type  text,
  shift_count   int,
  closed_shifts int,
  open_shifts   int,
  idle_shifts   int,
  total_minutes numeric,
  total_hours   numeric,
  last_shift_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select
    m.id, m.name, m.machine_type,
    count(s.id)::int,
    count(s.id) filter (where s.status = 'closed')::int,
    count(s.id) filter (where s.status = 'open')::int,
    count(s.id) filter (where s.status = 'flagged_idle')::int,
    round(coalesce(sum(extract(epoch from (s.closed_at - s.opened_at)) / 60)
                     filter (where s.closed_at is not null), 0)::numeric, 1),
    round(coalesce(sum(extract(epoch from (s.closed_at - s.opened_at)) / 3600)
                     filter (where s.closed_at is not null), 0)::numeric, 2),
    max(s.opened_at)
  from public.machines m
  left join public.shifts s on s.machine_id = m.id and s.factory_id = v_factory
  where m.factory_id = v_factory and m.deleted_at is null
  group by m.id, m.name, m.machine_type
  order by m.name;
end $$;

/** The shift records behind one machine's total, for hand-reconciliation. */
create or replace function public.acct_machine_shifts(p_machine_id uuid)
returns table (
  shift_id    uuid,
  worker_name text,
  status      text,
  opened_at   timestamptz,
  closed_at   timestamptz,
  minutes     numeric,
  stitches    int
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select s.id, p.display_name, s.status, s.opened_at, s.closed_at,
         case when s.closed_at is null then null
              else round((extract(epoch from (s.closed_at - s.opened_at)) / 60)::numeric, 1) end,
         greatest(coalesce(s.confirmed_stitches, 0) - s.open_stitches, 0)
  from public.shifts s
  left join public.profiles p on p.id = s.worker_id
  where s.factory_id = v_factory and s.machine_id = p_machine_id
  order by s.opened_at desc;
end $$;

-- ===========================================================================
-- 9. Box 6 — Invoices: receivable + the five payable categories
-- ===========================================================================

/** Receivable, factory-wide: the financial lens on the same invoice rows. */
create or replace function public.acct_receivable_summary()
returns table (
  invoice_count  int,
  unpaid_count   int,
  overdue_count  int,
  total_income   numeric,
  received       numeric,
  pending        numeric,
  overdue_amount numeric,
  next_due_date  date
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  with inv as (
    select i.* from public.invoices i
     where i.factory_id = v_factory and i.status <> 'cancelled'
  )
  select
    count(*)::int,
    count(*) filter (where inv.status <> 'paid')::int,
    count(*) filter (where inv.status <> 'paid'
                       and inv.due_date is not null and inv.due_date < current_date)::int,
    coalesce(sum(inv.amount), 0),
    coalesce((select sum(p.amount) from public.payments p
               where p.factory_id = v_factory and p.direction = 'receivable'
                 and p.ref_type = 'invoice'), 0),
    coalesce(sum(inv.amount) filter (where inv.status <> 'paid'), 0),
    coalesce(sum(inv.amount) filter (where inv.status <> 'paid'
                                       and inv.due_date is not null
                                       and inv.due_date < current_date), 0),
    min(inv.due_date) filter (where inv.status <> 'paid')
  from inv;
end $$;

/** Every receivable invoice with its client, for the Receivable list. */
create or replace function public.acct_receivable_invoices()
returns table (
  invoice_id   uuid,
  invoice_code text,
  vendor_id    uuid,
  vendor_name  text,
  order_code   text,
  amount       numeric,
  status       text,
  photo_url    text,
  due_date     date,
  issued_at    timestamptz,
  is_overdue   boolean
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select i.id, i.invoice_code, v.id, v.name, o.order_code, i.amount, i.status,
         i.photo_url, i.due_date, i.issued_at,
         (i.status <> 'paid' and i.due_date is not null and i.due_date < current_date)
  from public.invoices i
  join public.orders o on o.id = i.order_id
  join public.vendors v on v.id = o.vendor_id
  where i.factory_id = v_factory and i.status <> 'cancelled'
  order by (i.status = 'paid'), i.due_date nulls last, i.issued_at desc;
end $$;

/**
 * Payable 1 — finishing partners: earned, charged for damage, paid, still owed.
 *
 * SIGN NOTE: owner_approve_damage writes damage_charge rows as NEGATIVE amounts
 * (0024), while 0022's partner dashboard reads them as positive. Rather than
 * pick a side and be wrong on one of them, `damages` sums the MAGNITUDE and the
 * payable always subtracts it — correct under either convention.
 */
create or replace function public.acct_payable_partners()
returns table (
  partner_id uuid,
  name       text,
  stage_type text,
  earnings   numeric,
  damages    numeric,
  paid       numeric,
  payable    numeric
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  with led as (
    select pl.partner_id as pid,
           coalesce(sum(abs(pl.amount)) filter (where pl.entry_type = 'earning'), 0) as earnings,
           coalesce(sum(abs(pl.amount)) filter (where pl.entry_type = 'damage_charge'), 0) as damages,
           coalesce(sum(abs(pl.amount)) filter (where pl.entry_type = 'payment'), 0) as paid
      from public.partner_ledger pl
     where pl.factory_id = v_factory
     group by pl.partner_id
  )
  select fp.id, fp.name, fp.stage_type,
         coalesce(led.earnings, 0), coalesce(led.damages, 0), coalesce(led.paid, 0),
         coalesce(led.earnings, 0) - coalesce(led.damages, 0) - coalesce(led.paid, 0)
  from public.finishing_partners fp
  left join led on led.pid = fp.id
  where fp.factory_id = v_factory and fp.deleted_at is null
  order by fp.name;
end $$;

/** Payable 2 — suppliers: the POs that still owe money, with their status. */
create or replace function public.acct_payable_suppliers()
returns table (
  po_id           uuid,
  po_code         text,
  supplier_id     uuid,
  supplier_name   text,
  status          text,
  amount          numeric,
  quantity_meters numeric,
  created_at      timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select p.id, p.po_code, s.id, s.name, p.status, p.amount,
         coalesce((select sum(i.quantity_meters) from public.po_items i
                    where i.purchase_order_id = p.id), 0),
         p.created_at
  from public.purchase_orders p
  left join public.suppliers s on s.id = p.supplier_id
  where p.factory_id = v_factory
    and p.status not in ('paid','received','cancelled')
  order by p.created_at;
end $$;

/** Payable 3 + 4 — bills (by subtype) and maintenance, both from `expenses`. */
create or replace function public.acct_payable_expenses(p_category text)
returns table (
  expense_id   uuid,
  category     text,
  bill_subtype text,
  amount       numeric,
  description  text,
  proof_url    text,
  recurring    boolean,
  status       text,
  expense_date date
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select e.id, e.category, e.bill_subtype, e.amount, e.description, e.proof_url,
         e.recurring, e.status, e.expense_date
  from public.expenses e
  where e.factory_id = v_factory and e.category = p_category
  order by e.expense_date desc, e.created_at desc;
end $$;

/**
 * Bill types already used at this factory. This is the whole "add a new bill
 * type" mechanism: whatever was typed before is offered back, so the second
 * electricity bill reuses the first one's spelling instead of quietly creating
 * a near-duplicate type.
 */
create or replace function public.acct_bill_subtypes()
returns table (
  bill_subtype text,
  use_count    int,
  total_amount numeric,
  last_used    date
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select e.bill_subtype, count(*)::int, coalesce(sum(e.amount), 0), max(e.expense_date)
  from public.expenses e
  where e.factory_id = v_factory
    and e.category = 'bills'
    and e.bill_subtype is not null
  group by e.bill_subtype
  order by max(e.expense_date) desc;
end $$;

/**
 * Payable 5 — salary. A SUMMARY ONLY: the Salary Run screen owns the detail and
 * the finalize action, and duplicating either here would give a factory two
 * places to run payroll from. `unpaid_finalized` is the figure that matters —
 * pay that has been calculated and closed but has no payment proof attached yet.
 */
create or replace function public.acct_salary_outstanding(p_period text default null)
returns table (
  period           text,
  employee_count   int,
  pending_count    int,
  pending_net      numeric,
  finalized_net    numeric,
  unpaid_finalized numeric,
  next_pay_date    date
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_factory uuid := public.current_factory_id();
  v_period  text := coalesce(p_period, public.current_payroll_period());
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select
    v_period,
    count(distinct wl.worker_id)::int,
    count(distinct wl.worker_id) filter (where wl.status = 'pending')::int,
    coalesce(sum(wl.net) filter (where wl.status = 'pending'), 0),
    coalesce(sum(wl.net) filter (where wl.status = 'finalized'), 0),
    coalesce(sum(wl.net) filter (where wl.status = 'finalized'
                                   and wl.payment_proof_url is null), 0),
    (date_trunc('month', to_date(v_period || '-01', 'YYYY-MM-DD')) + interval '1 month')::date
  from public.worker_ledger wl
  where wl.factory_id = v_factory and wl.period = v_period;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.assert_proof_photo(text, text) to authenticated;
grant execute on function public.billing_day_of_month(date, int) to authenticated;
grant execute on function public.fm_generate_invoice(uuid, numeric, text, text, date) to authenticated;
grant execute on function public.acct_record_payment(text, uuid, numeric, text, text) to authenticated;
grant execute on function public.acct_add_expense(text, numeric, text, text, boolean, text) to authenticated;
grant execute on function public.acct_pay_partner(uuid, numeric, text, text) to authenticated;
grant execute on function public.acct_client_summary() to authenticated;
grant execute on function public.acct_client_invoices(uuid) to authenticated;
grant execute on function public.acct_client_damages(uuid) to authenticated;
grant execute on function public.acct_supplier_summary() to authenticated;
grant execute on function public.acct_supplier_pos(uuid) to authenticated;
grant execute on function public.acct_employee_summary(text) to authenticated;
grant execute on function public.acct_machine_summary() to authenticated;
grant execute on function public.acct_machine_shifts(uuid) to authenticated;
grant execute on function public.acct_receivable_summary() to authenticated;
grant execute on function public.acct_receivable_invoices() to authenticated;
grant execute on function public.acct_payable_partners() to authenticated;
grant execute on function public.acct_payable_suppliers() to authenticated;
grant execute on function public.acct_payable_expenses(text) to authenticated;
grant execute on function public.acct_bill_subtypes() to authenticated;
grant execute on function public.acct_salary_outstanding(text) to authenticated;
