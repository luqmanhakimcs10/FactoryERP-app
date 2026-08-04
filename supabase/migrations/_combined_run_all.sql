-- ============================================================
-- Factory ERP — COMBINED Phase 1 migration (paste-and-run once)
-- Runs: 0001 schema+RLS, 0002 seed reference, 0003 dev users
-- ============================================================

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


-- =============================================================================
-- Factory ERP — Phase 1 seed: roles, modules, two dummy factories.
-- Idempotent. Run AFTER 0001. Auth users + profiles come in 0003.
--
-- Two dummy factories exist from day one (anti-fraud checklist, spec §7.6):
-- every feature must be verified from BOTH tenants before it is called done.
-- =============================================================================

-- ---- Roles (the 11) ----
insert into public.roles (key, name) values
  ('super_admin',       'Super Admin'),
  ('company_admin',     'Owner'),
  ('accountant',        'Accountant'),
  ('floor_manager',     'Floor Manager'),
  ('store_manager',     'Store Manager'),
  ('order_taker',       'Order Taker'),
  ('qa',                'QA'),
  ('procurement',       'Procurement'),
  ('delivery',          'Delivery'),
  ('worker',            'Worker'),
  ('finishing_partner', 'Finishing Partner')
on conflict (key) do update set name = excluded.name;

-- ---- Modules (4 toggleable; auth/users/vendors/suppliers are core, not here) ----
insert into public.modules (key, name, is_core) values
  ('order_lifecycle',       'Order Lifecycle',        false),
  ('inventory_procurement', 'Inventory & Procurement', false),
  ('machine_workforce',     'Machine & Workforce',     false),
  ('finance_reports',       'Finance & Reports',       false)
on conflict (key) do update set name = excluded.name;

-- ---- Two dummy factories (fixed UUIDs so 0003 can reference them) ----
insert into public.factories (id, name, contact_email, contact_phone, plan) values
  ('11111111-1111-1111-1111-111111111111', 'Alpha Embroidery Works', 'owner@alpha.test', '+92-300-0000001', 'pro'),
  ('22222222-2222-2222-2222-222222222222', 'Beta Stitch House',      'owner@beta.test',  '+92-300-0000002', 'trial')
on conflict (id) do nothing;

-- ---- Module enablement per factory ----
-- Alpha: ALL modules enabled.
insert into public.factory_modules (factory_id, module_id, enabled, enabled_at)
select '11111111-1111-1111-1111-111111111111', m.id, true, now()
from public.modules m
on conflict (factory_id, module_id) do update
  set enabled = excluded.enabled, enabled_at = excluded.enabled_at;

-- Beta: Order Lifecycle + Inventory enabled; Machine & Workforce and Finance DISABLED
-- (so module-gating can be tested across the two tenants).
insert into public.factory_modules (factory_id, module_id, enabled, enabled_at)
select '22222222-2222-2222-2222-222222222222', m.id,
       (m.key in ('order_lifecycle', 'inventory_procurement')),
       case when m.key in ('order_lifecycle', 'inventory_procurement') then now() end
from public.modules m
on conflict (factory_id, module_id) do update
  set enabled = excluded.enabled, enabled_at = excluded.enabled_at;


-- =============================================================================
-- Factory ERP — Phase 1 DEV seed: test auth users + their profiles.
--
-- !!! DEVELOPMENT / DUMMY-TENANT USE ONLY. Never run against production. !!!
--
-- Creates one login per role in BOTH dummy factories, plus a super admin,
-- so role routing and cross-tenant isolation can be tested end to end.
-- All passwords: Password123!
--
--   Super admin:  super@erp.test
--   Alpha (factory 1111...):  <role>@alpha.test   e.g. owner@alpha.test, floor@alpha.test
--   Beta  (factory 2222...):  <role>@beta.test    e.g. owner@beta.test,  worker@beta.test
--
-- Run AFTER 0001 and 0002. Idempotent (skips auth users that already exist).
--
-- If your project's GoTrue/auth schema rejects these inserts, use the Dashboard
-- fallback instead: Authentication -> Users -> Add user for each email above,
-- then run 0003b_seed_profiles_by_email.sql to attach profiles.
-- =============================================================================

create extension if not exists pgcrypto;

do $$
declare
  r    record;
  uid  uuid;
begin
  for r in
    select * from (values
      -- email,                 factory_id,                                     role,               display_name
      ('super@erp.test',        null::uuid,                                     'super_admin',      'Platform Admin'),

      ('owner@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'company_admin',    'Alpha Owner'),
      ('accountant@alpha.test', '11111111-1111-1111-1111-111111111111'::uuid,  'accountant',       'Alpha Accountant'),
      ('floor@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'floor_manager',    'Alpha Floor Mgr'),
      ('store@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'store_manager',    'Alpha Store Mgr'),
      ('order@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'order_taker',      'Alpha Order Taker'),
      ('qa@alpha.test',         '11111111-1111-1111-1111-111111111111'::uuid,  'qa',               'Alpha QA'),
      ('procurement@alpha.test','11111111-1111-1111-1111-111111111111'::uuid,  'procurement',      'Alpha Procurement'),
      ('delivery@alpha.test',   '11111111-1111-1111-1111-111111111111'::uuid,  'delivery',         'Alpha Delivery'),
      ('worker@alpha.test',     '11111111-1111-1111-1111-111111111111'::uuid,  'worker',           'Alpha Worker'),
      ('partner@alpha.test',    '11111111-1111-1111-1111-111111111111'::uuid,  'finishing_partner','Alpha Partner'),

      ('owner@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'company_admin',    'Beta Owner'),
      ('accountant@beta.test',  '22222222-2222-2222-2222-222222222222'::uuid,  'accountant',       'Beta Accountant'),
      ('floor@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'floor_manager',    'Beta Floor Mgr'),
      ('store@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'store_manager',    'Beta Store Mgr'),
      ('order@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'order_taker',      'Beta Order Taker'),
      ('qa@beta.test',          '22222222-2222-2222-2222-222222222222'::uuid,  'qa',               'Beta QA'),
      ('procurement@beta.test', '22222222-2222-2222-2222-222222222222'::uuid,  'procurement',      'Beta Procurement'),
      ('delivery@beta.test',    '22222222-2222-2222-2222-222222222222'::uuid,  'delivery',         'Beta Delivery'),
      ('worker@beta.test',      '22222222-2222-2222-2222-222222222222'::uuid,  'worker',           'Beta Worker'),
      ('partner@beta.test',     '22222222-2222-2222-2222-222222222222'::uuid,  'finishing_partner','Beta Partner')
    ) as t(email, factory_id, role, display_name)
  loop
    select id into uid from auth.users where email = r.email;

    if uid is null then
      uid := gen_random_uuid();

      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
        r.email, crypt('Password123!', gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false
      );

      insert into auth.identities (
        provider_id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values (
        uid::text, uid,
        jsonb_build_object('sub', uid::text, 'email', r.email),
        'email', now(), now(), now()
      );
    end if;

    insert into public.profiles (id, factory_id, role, display_name)
    values (uid, r.factory_id, r.role, r.display_name)
    on conflict (id) do update
      set factory_id = excluded.factory_id,
          role = excluded.role,
          display_name = excluded.display_name;
  end loop;
end $$;
