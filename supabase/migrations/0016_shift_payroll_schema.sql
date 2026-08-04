-- =============================================================================
-- Factory ERP — Phase 5: Shift close + payroll
--
-- THE CENTRAL RULE OF THIS PHASE:
--   A shift-close panel photo IS the payroll record. Stitch counts come from
--   vision detection on cumulative machine counters, not self-report. The delta
--   between open and close photos drives worker_ledger entries.
--
-- Cumulative counters: close photo of shift N becomes open photo of shift N+1.
-- flagged_idle shifts are excluded from ledger posting entirely.
-- =============================================================================

-- Worker stitch rate (snapshotted into worker_ledger.base_per_stitch at posting).
alter table public.profiles
  add column if not exists stitch_rate numeric(12,4) check (stitch_rate is null or stitch_rate >= 0);

-- Floor manager ownership of machines (walk list is scoped to managed_by = caller).
alter table public.machines
  add column if not exists managed_by uuid references public.profiles(id) on delete set null;

create index if not exists idx_machines_managed on public.machines(managed_by)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
create table if not exists public.shifts (
  id                    uuid primary key default gen_random_uuid(),
  factory_id            uuid not null default public.current_factory_id()
                          references public.factories(id) on delete cascade,
  machine_id            uuid not null references public.machines(id) on delete restrict,
  worker_id             uuid not null references public.profiles(id) on delete restrict,
  order_id              uuid references public.orders(id) on delete set null,
  open_panel_photo_url  text not null,
  open_stitches         int not null default 0 check (open_stitches >= 0),
  close_panel_photo_url text,
  detected_stitches     int check (detected_stitches is null or detected_stitches >= 0),
  confirmed_stitches    int check (confirmed_stitches is null or confirmed_stitches >= 0),
  closed_by             uuid references public.profiles(id) on delete set null,
  closed_at             timestamptz,
  status                text not null default 'open'
                          check (status in ('open','closed','flagged_idle')),
  opened_by             uuid references public.profiles(id) on delete set null,
  opened_at             timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

-- One open shift per machine at a time.
create unique index if not exists uq_shifts_machine_open
  on public.shifts(machine_id) where status = 'open';

create index if not exists idx_shifts_factory_status on public.shifts(factory_id, status);
create index if not exists idx_shifts_machine on public.shifts(machine_id, opened_at desc);
create index if not exists idx_shifts_worker on public.shifts(worker_id, opened_at desc);

-- ---------------------------------------------------------------------------
-- Downtime (FM confirms during shift close)
-- ---------------------------------------------------------------------------
create table if not exists public.downtime_reports (
  id               uuid primary key default gen_random_uuid(),
  factory_id       uuid not null default public.current_factory_id()
                     references public.factories(id) on delete cascade,
  shift_id         uuid not null references public.shifts(id) on delete cascade,
  duration_minutes int not null check (duration_minutes >= 0),
  reason           text not null,
  reported_by      uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_downtime_shift on public.downtime_reports(shift_id);

-- ---------------------------------------------------------------------------
-- Bonus slabs (owner-configured; applied automatically at shift close)
-- ---------------------------------------------------------------------------
create table if not exists public.bonus_slabs (
  id                      uuid primary key default gen_random_uuid(),
  factory_id              uuid not null default public.current_factory_id()
                            references public.factories(id) on delete cascade,
  daily_stitch_threshold  int not null check (daily_stitch_threshold > 0),
  bonus_amount            numeric(14,2) not null check (bonus_amount >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_bonus_slabs_factory on public.bonus_slabs(factory_id, daily_stitch_threshold);

drop trigger if exists trg_bonus_slabs_touch on public.bonus_slabs;
create trigger trg_bonus_slabs_touch before update on public.bonus_slabs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Worker ledger (payroll postings from shift close)
-- ---------------------------------------------------------------------------
create table if not exists public.worker_ledger (
  id                 uuid primary key default gen_random_uuid(),
  factory_id         uuid not null default public.current_factory_id()
                       references public.factories(id) on delete cascade,
  worker_id          uuid not null references public.profiles(id) on delete restrict,
  shift_id           uuid references public.shifts(id) on delete set null,
  period             text not null,
  stitch_count       int not null default 0 check (stitch_count >= 0),
  base_per_stitch    numeric(12,4) not null check (base_per_stitch >= 0),
  bonus              numeric(14,2) not null default 0 check (bonus >= 0),
  damage_deduction   numeric(14,2) not null default 0 check (damage_deduction >= 0),
  loan_installment   numeric(14,2) not null default 0 check (loan_installment >= 0),
  net                numeric(14,2) not null,
  status             text not null default 'pending'
                       check (status in ('pending','finalized')),
  payment_proof_url  text,
  finalized_at       timestamptz,
  finalized_by       uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);

create index if not exists idx_worker_ledger_period on public.worker_ledger(factory_id, period, status);
create index if not exists idx_worker_ledger_worker on public.worker_ledger(worker_id, period);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.shifts           enable row level security;
alter table public.downtime_reports enable row level security;
alter table public.bonus_slabs      enable row level security;
alter table public.worker_ledger    enable row level security;

-- ---- shifts ----
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('machine_workforce')
  );

drop policy if exists shifts_insert on public.shifts;
-- Direct inserts disallowed; shift creation must go through fm_open_shift RPC.

drop policy if exists shifts_update on public.shifts;
create policy shifts_update on public.shifts
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['floor_manager','company_admin'])
  )
  with check (factory_id = public.current_factory_id());

-- ---- downtime_reports ----
drop policy if exists downtime_select on public.downtime_reports;
create policy downtime_select on public.downtime_reports
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('machine_workforce')
  );

drop policy if exists downtime_insert on public.downtime_reports;
create policy downtime_insert on public.downtime_reports
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['floor_manager','company_admin'])
  );

-- ---- bonus_slabs ----
drop policy if exists bonus_slabs_select on public.bonus_slabs;
create policy bonus_slabs_select on public.bonus_slabs
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('machine_workforce')
  );

drop policy if exists bonus_slabs_write on public.bonus_slabs;
create policy bonus_slabs_write on public.bonus_slabs
  for all to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['company_admin'])
  )
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['company_admin'])
  );

-- ---- worker_ledger ----
drop policy if exists worker_ledger_select on public.worker_ledger;
create policy worker_ledger_select on public.worker_ledger
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('machine_workforce')
    and (
      public.has_any_role(array['accountant','company_admin','floor_manager'])
      or worker_id = auth.uid()
    )
  );

drop policy if exists worker_ledger_insert on public.worker_ledger;
create policy worker_ledger_insert on public.worker_ledger
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['floor_manager','company_admin'])
  );

drop policy if exists worker_ledger_update on public.worker_ledger;
create policy worker_ledger_update on public.worker_ledger
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['accountant','company_admin'])
  )
  with check (factory_id = public.current_factory_id());
