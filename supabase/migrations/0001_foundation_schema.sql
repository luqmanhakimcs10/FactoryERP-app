-- =============================================================================
-- Factory ERP — Phase 1 Foundation schema
-- Tenancy + auth-profile + module registry, with Row Level Security from day one.
--
-- Tenant isolation and module gating are enforced HERE (RLS), not in app code.
-- Run this in the Supabase SQL editor (or via the CLI) against a fresh project.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.factories (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_email text,
  contact_phone text,
  plan          text default 'trial',
  created_at    timestamptz not null default now()
);

-- Module registry (global, not tenant-scoped).
create table if not exists public.modules (
  id       uuid primary key default gen_random_uuid(),
  key      text not null unique,   -- e.g. order_lifecycle
  name     text not null,
  is_core  boolean not null default false
);

-- Per-factory module enablement (the module-gating source of truth).
create table if not exists public.factory_modules (
  id          uuid primary key default gen_random_uuid(),
  factory_id  uuid not null references public.factories(id) on delete cascade,
  module_id   uuid not null references public.modules(id) on delete cascade,
  enabled     boolean not null default false,
  enabled_at  timestamptz,
  unique (factory_id, module_id)
);

-- Role reference table (labels; profiles.role is the effective field).
create table if not exists public.roles (
  key   text primary key,
  name  text not null
);

-- profiles extends auth.users: who is logged in, which factory, what role.
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  factory_id    uuid references public.factories(id) on delete cascade,
  role          text not null references public.roles(key),
  display_name  text not null default '',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- super_admin operates cross-tenant, so it has no factory_id; every other role must.
alter table public.profiles
  drop constraint if exists profiles_factory_scope_chk;
alter table public.profiles
  add constraint profiles_factory_scope_chk
  check (
    (role = 'super_admin' and factory_id is null)
    or (role <> 'super_admin' and factory_id is not null)
  );

create index if not exists idx_profiles_factory on public.profiles(factory_id);
create index if not exists idx_factory_modules_factory on public.factory_modules(factory_id);

-- ---------------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER to read profiles without recursing
-- into the profiles RLS policies that call them).
-- ---------------------------------------------------------------------------

create or replace function public.current_factory_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select factory_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_user_role()
returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'super_admin'
  )
$$;

-- Module gating helper — later phases gate business tables with this in their policies.
create or replace function public.module_enabled(p_module_key text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select fm.enabled
    from public.factory_modules fm
    join public.modules m on m.id = fm.module_id
    where fm.factory_id = public.current_factory_id()
      and m.key = p_module_key
  ), false)
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table (day one).
-- ---------------------------------------------------------------------------
alter table public.factories       enable row level security;
alter table public.modules         enable row level security;
alter table public.factory_modules enable row level security;
alter table public.roles           enable row level security;
alter table public.profiles        enable row level security;

-- ---------------------------------------------------------------------------
-- Policies. Pattern: read scoped to caller's own factory_id; super_admin
-- transcends for tenancy management only (never business data — none here yet).
-- ---------------------------------------------------------------------------

-- factories
drop policy if exists factories_select on public.factories;
create policy factories_select on public.factories
  for select to authenticated
  using (id = public.current_factory_id() or public.is_super_admin());

drop policy if exists factories_write on public.factories;
create policy factories_write on public.factories
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- modules (global registry: any authenticated user may read; only super admin writes)
drop policy if exists modules_select on public.modules;
create policy modules_select on public.modules
  for select to authenticated
  using (true);

drop policy if exists modules_write on public.modules;
create policy modules_write on public.modules
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- factory_modules
drop policy if exists factory_modules_select on public.factory_modules;
create policy factory_modules_select on public.factory_modules
  for select to authenticated
  using (factory_id = public.current_factory_id() or public.is_super_admin());

drop policy if exists factory_modules_write on public.factory_modules;
create policy factory_modules_write on public.factory_modules
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- roles (reference labels: readable by all authenticated; super admin writes)
drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles
  for select to authenticated
  using (true);

drop policy if exists roles_write on public.roles;
create policy roles_write on public.roles
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- profiles: a user always sees their own row; otherwise scoped to own factory;
-- super admin sees all (user provisioning). Writes are super-admin only in Phase 1.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or factory_id = public.current_factory_id()
    or public.is_super_admin()
  );

drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());
