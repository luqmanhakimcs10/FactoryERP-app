-- =============================================================================
-- Factory ERP — Phase 7: Finance posting, approvals, and reports
--
-- This phase closes loops other phases deliberately left open:
--   * Phase 6 deferred invoice generation  -> `invoices` here
--   * Phase 4 left POs at "awaiting owner approval" / "awaiting accountant
--     payment" -> the owner's approval and the accountant's payment actually
--     resolve those states here
--   * Phase 5 promised that an approved damage record reduces pay -> the owner's
--     approval here is what writes worker_ledger.damage_deduction
--
-- COMPATIBILITY NOTE: an unapplied migration (0022_phase8_dashboard_schema.sql)
-- also declares `loans` and `partner_ledger` for Phase 8's dashboards. Both are
-- created here with `if not exists` and a superset of columns, so whichever runs
-- first wins and the other no-ops without conflict.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Invoices — raised by the floor manager at final QA
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  order_id     uuid not null references public.orders(id) on delete cascade,
  invoice_code text not null,
  amount       numeric(14,2) not null check (amount >= 0),
  status       text not null default 'pending' check (status in ('pending','paid','cancelled')),
  issued_by    uuid references public.profiles(id) on delete set null,
  issued_at    timestamptz not null default now(),
  paid_at      timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists uq_invoice_code on public.invoices(invoice_code);
-- One live invoice per order; a cancelled one may be superseded.
create unique index if not exists uq_invoice_order on public.invoices(order_id)
  where status <> 'cancelled';
create index if not exists idx_invoices_factory_status on public.invoices(factory_id, status);

-- ---------------------------------------------------------------------------
-- Expenses — fixed, manual, and partner payments
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  factory_id    uuid not null default public.current_factory_id()
                  references public.factories(id) on delete cascade,
  category      text not null check (category in
                  ('rent','utilities','maintenance','partner_payment','materials','other')),
  amount        numeric(14,2) not null check (amount >= 0),
  description   text,
  proof_url     text,
  recurring     boolean not null default false,
  expense_date  date not null default current_date,
  -- Expenses need owner sign-off; partner payments are pre-approved because the
  -- earning they settle was already approved upstream.
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_by   uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz,
  recorded_by   uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_expenses_factory on public.expenses(factory_id, expense_date desc);
create index if not exists idx_expenses_status on public.expenses(factory_id, status);

-- ---------------------------------------------------------------------------
-- Payments — both directions, always with proof
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  direction    text not null check (direction in ('receivable','payable')),
  ref_type     text not null check (ref_type in ('invoice','po','partner','salary')),
  ref_id       uuid,
  amount       numeric(14,2) not null check (amount > 0),
  proof_url    text,
  paid_at      timestamptz not null default now(),
  recorded_by  uuid references public.profiles(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_payments_factory on public.payments(factory_id, paid_at desc);
create index if not exists idx_payments_ref on public.payments(ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Loans — recorded, never approved here (approval happens outside the app)
-- ---------------------------------------------------------------------------
create table if not exists public.loans (
  id                 uuid primary key default gen_random_uuid(),
  factory_id         uuid not null default public.current_factory_id()
                       references public.factories(id) on delete cascade,
  worker_id          uuid not null references public.profiles(id) on delete restrict,
  principal          numeric(14,2) not null check (principal >= 0),
  balance            numeric(14,2) not null check (balance >= 0),
  installment_amount numeric(14,2) not null default 0 check (installment_amount >= 0),
  status             text not null default 'active' check (status in ('active','paid_off')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Present in the brief's shape but not in 0022's; added so both agree.
alter table public.loans add column if not exists recorded_by uuid references public.profiles(id) on delete set null;
-- The period a loan starts deducting from. Set at creation to the period AFTER
-- the current one, which is what makes deduction non-retroactive: a salary run
-- for an already-closed period can never pick it up.
alter table public.loans add column if not exists starts_period text;

create index if not exists idx_loans_factory_worker on public.loans(factory_id, worker_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- Partner ledger
-- ---------------------------------------------------------------------------
create table if not exists public.partner_ledger (
  id               uuid primary key default gen_random_uuid(),
  factory_id       uuid not null default public.current_factory_id()
                     references public.factories(id) on delete cascade,
  partner_id       uuid not null references public.finishing_partners(id) on delete restrict,
  entry_type       text not null check (entry_type in ('earning','damage_charge','payment')),
  amount           numeric(14,2) not null,
  period           text not null,
  repeat_id        uuid references public.repeats(id) on delete set null,
  damage_record_id uuid references public.damage_records(id) on delete set null,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

-- Columns from the Phase 7 brief that 0022 does not declare.
alter table public.partner_ledger add column if not exists rate_basis text;
alter table public.partner_ledger add column if not exists quantity numeric(14,2);
alter table public.partner_ledger add column if not exists ref_id uuid;
-- Links an earning back to the order stage it came from, so per-order
-- profitability can attribute finishing cost to the right order.
alter table public.partner_ledger add column if not exists order_stage_id uuid
  references public.order_stages(id) on delete set null;

create index if not exists idx_partner_ledger_factory_partner
  on public.partner_ledger(factory_id, partner_id, period);
create index if not exists idx_partner_ledger_stage on public.partner_ledger(order_stage_id);

-- ---------------------------------------------------------------------------
-- Per-user permission add-ons
--
-- These SUPPLEMENT the base role from Phase 1; they never replace or remove it.
-- The client-side utility reads them for render/route decisions, and RLS remains
-- the real enforcement — a granted key does not widen any policy by itself.
-- ---------------------------------------------------------------------------
create table if not exists public.user_permissions (
  id             uuid primary key default gen_random_uuid(),
  factory_id     uuid not null default public.current_factory_id()
                   references public.factories(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null,
  granted_by     uuid references public.profiles(id) on delete set null,
  granted_at     timestamptz not null default now(),
  unique (user_id, permission_key)
);

create index if not exists idx_user_permissions_user on public.user_permissions(user_id);

-- ---------------------------------------------------------------------------
-- Bonus slab change proposals
--
-- Distinct from the owner's direct-edit screen built in Phase 5: a proposal is
-- how a non-owner asks for a change, and it only touches bonus_slabs on approval.
-- ---------------------------------------------------------------------------
create table if not exists public.bonus_slab_proposals (
  id                     uuid primary key default gen_random_uuid(),
  factory_id             uuid not null default public.current_factory_id()
                           references public.factories(id) on delete cascade,
  action                 text not null check (action in ('create','update','delete')),
  bonus_slab_id          uuid references public.bonus_slabs(id) on delete cascade,
  daily_stitch_threshold int,
  bonus_amount           numeric(12,2),
  reason                 text,
  status                 text not null default 'pending' check (status in ('pending','approved','rejected')),
  proposed_by            uuid references public.profiles(id) on delete set null,
  decided_by             uuid references public.profiles(id) on delete set null,
  decided_at             timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists idx_slab_proposals_status on public.bonus_slab_proposals(factory_id, status);

-- ---------------------------------------------------------------------------
-- Damage records: record the resolution, not just the approval.
-- A rejected record must be distinguishable from one still pending, and both
-- from one approved with a zero deduction.
-- ---------------------------------------------------------------------------
alter table public.damage_records
  add column if not exists approval_status text not null default 'pending',
  add column if not exists ledger_applied_period text;

alter table public.damage_records drop constraint if exists damage_approval_status_chk;
alter table public.damage_records add constraint damage_approval_status_chk
  check (approval_status in ('pending','approved','rejected'));

-- Existing rows that were already approved upstream keep their meaning.
update public.damage_records
   set approval_status = 'approved'
 where approved_by is not null and approval_status = 'pending';

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['invoices','expenses','loans']
  loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', t, t);
    execute format('create trigger trg_%s_touch before update on public.%I
                    for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.invoices             enable row level security;
alter table public.expenses             enable row level security;
alter table public.payments             enable row level security;
alter table public.loans                enable row level security;
alter table public.partner_ledger       enable row level security;
alter table public.user_permissions     enable row level security;
alter table public.bonus_slab_proposals enable row level security;

-- Finance data is gated on Finance & Reports and readable by the roles that need
-- it. Writes go through the SECURITY DEFINER RPCs in 0024, which enforce the
-- state machine and role rules a policy cannot express.
do $$
declare t text;
begin
  foreach t in array array['invoices','expenses','payments','bonus_slab_proposals']
  loop
    execute format('drop policy if exists %s_select on public.%I', t, t);
    execute format($f$
      create policy %s_select on public.%I
        for select to authenticated
        using (
          (factory_id = public.current_factory_id()
           and public.module_enabled('finance_reports'))
          or public.is_super_admin()
        )
    $f$, t, t);
  end loop;
end $$;

-- Loans: a worker may see their own; finance roles see all.
drop policy if exists loans_select on public.loans;
create policy loans_select on public.loans
  for select to authenticated
  using (
    (factory_id = public.current_factory_id()
     and (
       public.has_any_role(array['accountant','company_admin','floor_manager'])
       or worker_id = auth.uid()
     ))
    or public.is_super_admin()
  );

-- Partner ledger: a partner may see their own; finance roles see all.
drop policy if exists partner_ledger_select on public.partner_ledger;
create policy partner_ledger_select on public.partner_ledger
  for select to authenticated
  using (
    (factory_id = public.current_factory_id()
     and (
       public.has_any_role(array['accountant','company_admin','floor_manager'])
       or exists (
         select 1 from public.finishing_partners fp
          where fp.id = partner_ledger.partner_id and fp.user_id = auth.uid()
       )
     ))
    or public.is_super_admin()
  );

-- Permission grants: a user may see their own (the app reads them at login);
-- the owner sees all for the factory.
drop policy if exists user_permissions_select on public.user_permissions;
create policy user_permissions_select on public.user_permissions
  for select to authenticated
  using (
    user_id = auth.uid()
    or (factory_id = public.current_factory_id()
        and public.has_any_role(array['company_admin']))
    or public.is_super_admin()
  );

-- Granting is the owner's alone, and only within their own factory.
drop policy if exists user_permissions_write on public.user_permissions;
create policy user_permissions_write on public.user_permissions
  for all to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin'])
  )
  with check (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin'])
    -- Cannot grant to someone in another factory.
    and exists (
      select 1 from public.profiles p
       where p.id = user_id and p.factory_id = public.current_factory_id()
    )
  );

-- Proposing a bonus slab change is open to the roles that run the floor;
-- deciding on it is not (that RPC asserts company_admin).
drop policy if exists bonus_slab_proposals_insert on public.bonus_slab_proposals;
create policy bonus_slab_proposals_insert on public.bonus_slab_proposals
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('finance_reports')
    and public.has_any_role(array['company_admin','accountant','floor_manager'])
    and status = 'pending'
  );
