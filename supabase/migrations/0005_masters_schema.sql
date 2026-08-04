-- =============================================================================
-- Factory ERP — Phase 2: Master data (vendors, suppliers, machines, partners)
--
-- Same discipline as Phase 1: every table carries factory_id, RLS on from
-- creation, all scoping enforced HERE and not in app code.
--
-- Two things worth knowing before reading the policies:
--
-- 1. SOFT DELETE. Masters are reference data that Phase 3+ links to (orders ->
--    vendors, job cards -> machines, partner ledger -> finishing partners).
--    Hard-deleting a vendor with historical orders either fails on an FK or
--    destroys the audit trail, so `deleted_at` archives instead. Lists filter
--    archived rows out; nothing is ever orphaned.
--
-- 2. MODULE GATING IS IN RLS. Per spec §1, vendor + supplier masters are
--    platform core (never toggleable). Machines belong to Machine & Workforce
--    and finishing partners to Order Lifecycle, so their policies call
--    module_enabled() — a factory with the module off is rejected at the DB,
--    not merely hidden in the UI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Role helper: does the caller hold one of these roles (super admin included)?
-- ---------------------------------------------------------------------------
create or replace function public.has_any_role(p_roles text[])
returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_user_role() = any(p_roles)
$$;

-- Keeps updated_at honest without app-layer bookkeeping.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Vendors = customers who place orders. CORE (not module-gated).
create table if not exists public.vendors (
  id         uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,
  name       text not null,
  contact    text,
  address    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Suppliers = thread sellers. Deliberately a separate entity from vendors. CORE.
create table if not exists public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,
  name       text not null,
  contact    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Machines. Gated on the Machine & Workforce module.
create table if not exists public.machines (
  id         uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Finishing partners (external). Gated on the Order Lifecycle module.
-- `name` is not in the v1 ERD but a list/picker needs a human label, so it's here.
-- user_id links the partner to their own read-only dashboard login.
create table if not exists public.finishing_partners (
  id         uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,
  name       text not null,
  stage_type text not null check (stage_type in ('embroidery','clipping','press','piko')),
  rate_basis text not null check (rate_basis in ('per_stitch','per_repeat')),
  rate       numeric(12,4) not null default 0 check (rate >= 0),
  -- restrict: never silently unlink a partner from their login.
  user_id    uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Indexes: every list query filters factory_id + deleted_at is null.
create index if not exists idx_vendors_factory   on public.vendors(factory_id) where deleted_at is null;
create index if not exists idx_suppliers_factory on public.suppliers(factory_id) where deleted_at is null;
create index if not exists idx_machines_factory  on public.machines(factory_id) where deleted_at is null;
create index if not exists idx_partners_factory  on public.finishing_partners(factory_id) where deleted_at is null;

-- Names are unique per factory among live rows (archived duplicates are fine).
create unique index if not exists uq_vendors_name   on public.vendors(factory_id, lower(name)) where deleted_at is null;
create unique index if not exists uq_suppliers_name on public.suppliers(factory_id, lower(name)) where deleted_at is null;
create unique index if not exists uq_machines_name  on public.machines(factory_id, lower(name)) where deleted_at is null;
create unique index if not exists uq_partners_name  on public.finishing_partners(factory_id, lower(name)) where deleted_at is null;

-- updated_at triggers
drop trigger if exists trg_vendors_touch on public.vendors;
create trigger trg_vendors_touch before update on public.vendors
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_suppliers_touch on public.suppliers;
create trigger trg_suppliers_touch before update on public.suppliers
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_machines_touch on public.machines;
create trigger trg_machines_touch before update on public.machines
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_partners_touch on public.finishing_partners;
create trigger trg_partners_touch before update on public.finishing_partners
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS on, day one.
-- ---------------------------------------------------------------------------
alter table public.vendors            enable row level security;
alter table public.suppliers          enable row level security;
alter table public.machines           enable row level security;
alter table public.finishing_partners enable row level security;

-- ---------------------------------------------------------------------------
-- Policies.
--
-- Reads: any authenticated user in the owning factory (masters are shared
--        reference data — a floor manager must see the vendor name on a job
--        card). Super admin may read across factories for support, but never
--        writes business data (spec §2).
-- Writes: restricted to the roles that own each master.
-- ---------------------------------------------------------------------------

-- ---- vendors: owned by order_taker + company_admin ----
drop policy if exists vendors_select on public.vendors;
create policy vendors_select on public.vendors
  for select to authenticated
  using (factory_id = public.current_factory_id() or public.is_super_admin());

drop policy if exists vendors_insert on public.vendors;
create policy vendors_insert on public.vendors
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin','order_taker'])
  );

drop policy if exists vendors_update on public.vendors;
create policy vendors_update on public.vendors
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin','order_taker'])
  )
  with check (factory_id = public.current_factory_id());

drop policy if exists vendors_delete on public.vendors;
create policy vendors_delete on public.vendors
  for delete to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin'])
  );

-- ---- suppliers: owned by procurement + accountant + company_admin ----
drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select to authenticated
  using (factory_id = public.current_factory_id() or public.is_super_admin());

drop policy if exists suppliers_insert on public.suppliers;
create policy suppliers_insert on public.suppliers
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin','procurement','accountant'])
  );

drop policy if exists suppliers_update on public.suppliers;
create policy suppliers_update on public.suppliers
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin','procurement','accountant'])
  )
  with check (factory_id = public.current_factory_id());

drop policy if exists suppliers_delete on public.suppliers;
create policy suppliers_delete on public.suppliers
  for delete to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin'])
  );

-- ---- machines: owned by floor_manager + company_admin. MODULE-GATED. ----
drop policy if exists machines_select on public.machines;
create policy machines_select on public.machines
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() and public.module_enabled('machine_workforce'))
    or public.is_super_admin()
  );

drop policy if exists machines_insert on public.machines;
create policy machines_insert on public.machines
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['company_admin','floor_manager'])
  );

drop policy if exists machines_update on public.machines;
create policy machines_update on public.machines
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['company_admin','floor_manager'])
  )
  with check (factory_id = public.current_factory_id());

drop policy if exists machines_delete on public.machines;
create policy machines_delete on public.machines
  for delete to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('machine_workforce')
    and public.has_any_role(array['company_admin'])
  );

-- ---- finishing_partners: owned by company_admin + accountant. MODULE-GATED. ----
drop policy if exists partners_select on public.finishing_partners;
create policy partners_select on public.finishing_partners
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() and public.module_enabled('order_lifecycle'))
    or public.is_super_admin()
  );

drop policy if exists partners_insert on public.finishing_partners;
create policy partners_insert on public.finishing_partners
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
    and public.has_any_role(array['company_admin','accountant'])
  );

drop policy if exists partners_update on public.finishing_partners;
create policy partners_update on public.finishing_partners
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
    and public.has_any_role(array['company_admin','accountant'])
  )
  with check (factory_id = public.current_factory_id());

drop policy if exists partners_delete on public.finishing_partners;
create policy partners_delete on public.finishing_partners
  for delete to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
    and public.has_any_role(array['company_admin'])
  );
