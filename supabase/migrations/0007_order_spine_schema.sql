-- =============================================================================
-- Factory ERP — Phase 3: the order spine (order -> sheets -> repeats)
--
-- THE CENTRAL RULE OF THIS SCHEMA:
--   `repeat_stage_history` is the single source of truth for where a repeat is.
--   `repeats.current_status` is a DENORMALIZED CONVENIENCE CACHE. It exists so
--   list screens can filter without aggregating history, and it is only ever
--   written by the same function that inserts the history row (see 0008), so the
--   two cannot drift. Never update current_status on its own; never read it when
--   you need provenance (who moved it, when, with what photo) — read history.
--
-- Every table carries factory_id directly (rather than resolving through a
-- parent chain) so RLS stays a single indexed comparison instead of a recursive
-- subquery on the highest-volume tables in the system.
--
-- Module gate: the whole spine is the Order Lifecycle module. Thread stock and
-- purchase orders belong to Inventory & Procurement.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Human-readable code prefixes + per-factory counters
-- ---------------------------------------------------------------------------

alter table public.factories
  add column if not exists code_prefix text;

-- Backfill: first three alphanumerics of the name, uppercased.
update public.factories
set code_prefix = upper(substring(regexp_replace(name, '[^A-Za-z0-9]', '', 'g') from 1 for 3))
where code_prefix is null;

alter table public.factories
  alter column code_prefix set not null;

-- Sequential, per-tenant numbering for order and PO codes. A counter row per
-- factory (locked on update) keeps codes gap-free and human-friendly, which a
-- shared Postgres sequence could not.
create table if not exists public.factory_counters (
  factory_id uuid primary key references public.factories(id) on delete cascade,
  order_seq  bigint not null default 0,
  po_seq     bigint not null default 0
);

insert into public.factory_counters (factory_id)
select id from public.factories
on conflict (factory_id) do nothing;

-- ---------------------------------------------------------------------------
-- Order spine
-- ---------------------------------------------------------------------------

create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  factory_id       uuid not null default public.current_factory_id()
                     references public.factories(id) on delete cascade,
  vendor_id        uuid not null references public.vendors(id) on delete restrict,
  order_number     bigint,
  order_code       text,
  status           text not null default 'draft' check (status in (
                     'draft',
                     'awaiting_procurement',
                     'awaiting_cloth_inspection',
                     'awaiting_coding',
                     'awaiting_job_card',
                     'job_card_shared',
                     'job_card_confirmed',
                     'cancelled'
                   )),
  cloth_photos     text[] not null default '{}',
  design_sheet_url text,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  submitted_at     timestamptz
);

create unique index if not exists uq_orders_code on public.orders(order_code) where order_code is not null;
create index if not exists idx_orders_factory on public.orders(factory_id);
create index if not exists idx_orders_status on public.orders(factory_id, status);

-- The order's finishing sequence. Written by the floor manager's stage picker;
-- every repeat travels through these in `sequence` order.
create table if not exists public.order_stages (
  id              uuid primary key default gen_random_uuid(),
  factory_id      uuid not null default public.current_factory_id()
                    references public.factories(id) on delete cascade,
  order_id        uuid not null references public.orders(id) on delete cascade,
  stage_type      text not null check (stage_type in ('embroidery','clipping','press','piko')),
  sequence        int not null check (sequence > 0),
  is_outsourced   boolean not null default false,
  sla_hours       int not null default 24 check (sla_hours > 0),
  handler_user_id uuid references public.profiles(id) on delete set null,
  partner_id      uuid references public.finishing_partners(id) on delete restrict,
  created_at      timestamptz not null default now(),
  unique (order_id, sequence),
  unique (order_id, stage_type)
);

create index if not exists idx_order_stages_order on public.order_stages(order_id, sequence);

-- A sheet is a colour grouping within an order. The brief lists only
-- color_assignment, but the sheet builder also captures the repeat count,
-- thread colours and stitch count per sheet — those live here because they are
-- properties of the sheet, and repeats_count is what repeat coding expands.
create table if not exists public.sheets (
  id                 uuid primary key default gen_random_uuid(),
  factory_id         uuid not null default public.current_factory_id()
                       references public.factories(id) on delete cascade,
  order_id           uuid not null references public.orders(id) on delete cascade,
  sheet_number       int not null check (sheet_number > 0),
  color_assignment   text not null,
  repeats_count      int not null check (repeats_count > 0),
  thread_color_codes text[] not null default '{}',
  stitch_count       int not null check (stitch_count >= 0),
  created_at         timestamptz not null default now(),
  unique (order_id, sheet_number)
);

create index if not exists idx_sheets_order on public.sheets(order_id, sheet_number);

-- THE atomic tracked unit. One row per physical repeat, created at QA coding.
create table if not exists public.repeats (
  id             uuid primary key default gen_random_uuid(),
  factory_id     uuid not null default public.current_factory_id()
                   references public.factories(id) on delete cascade,
  sheet_id       uuid not null references public.sheets(id) on delete cascade,
  repeat_number  int not null check (repeat_number > 0),
  repeat_code    text not null,
  -- DENORMALIZED CACHE of the latest repeat_stage_history.status. Written only
  -- alongside a history insert. Not the record of truth.
  current_status text not null default 'coded' check (current_status in (
                   'coded',
                   'awaiting_job_card',
                   'ready_for_production',
                   'in_production',
                   'in_finishing',
                   'awaiting_final_qa',
                   'completed',
                   'damaged'
                 )),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (sheet_id, repeat_number)
);

-- Globally unique: the prefix embeds the factory, so this holds across tenants
-- and a scanned/typed code can never be ambiguous.
create unique index if not exists uq_repeats_code on public.repeats(repeat_code);
create index if not exists idx_repeats_sheet on public.repeats(sheet_id, repeat_number);
create index if not exists idx_repeats_status on public.repeats(factory_id, current_status);

-- ============================ SOURCE OF TRUTH ============================
-- Append-only log of every stage transition a repeat makes. Later phases (shift
-- close, finishing SLA, damage accountability, per-order profitability) all
-- derive a repeat's position and history FROM HERE. Never delete or update rows.
--
-- order_stage_id is nullable: lifecycle events before the floor manager picks a
-- stage sequence (notably 'coded' at QA coding time) have no stage to point at.
-- =========================================================================
create table if not exists public.repeat_stage_history (
  id             uuid primary key default gen_random_uuid(),
  factory_id     uuid not null default public.current_factory_id()
                   references public.factories(id) on delete cascade,
  repeat_id      uuid not null references public.repeats(id) on delete cascade,
  order_stage_id uuid references public.order_stages(id) on delete set null,
  status         text not null,
  actor_user_id  uuid references public.profiles(id) on delete set null,
  photo_url      text,
  note           text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_rsh_repeat on public.repeat_stage_history(repeat_id, created_at desc);
create index if not exists idx_rsh_factory on public.repeat_stage_history(factory_id, created_at desc);
create index if not exists idx_rsh_stage on public.repeat_stage_history(order_stage_id);

-- ---------------------------------------------------------------------------
-- Job cards
-- ---------------------------------------------------------------------------

create table if not exists public.job_cards (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  order_id     uuid not null references public.orders(id) on delete cascade,
  status       text not null default 'draft' check (status in ('draft','shared','confirmed')),
  -- Set when the vendor asks for changes; cleared on the next share.
  change_notes text,
  revision     int not null default 1,
  shared_at    timestamptz,
  confirmed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One live job card per order.
create unique index if not exists uq_job_cards_order on public.job_cards(order_id);

create table if not exists public.job_card_lines (
  id                uuid primary key default gen_random_uuid(),
  factory_id        uuid not null default public.current_factory_id()
                      references public.factories(id) on delete cascade,
  job_card_id       uuid not null references public.job_cards(id) on delete cascade,
  sheet_id          uuid references public.sheets(id) on delete cascade,
  needle_number     int not null check (needle_number > 0),
  thread_color_code text not null,
  stitch_count      int,
  created_at        timestamptz not null default now(),
  unique (job_card_id, needle_number)
);

create index if not exists idx_jcl_card on public.job_card_lines(job_card_id, needle_number);

-- ---------------------------------------------------------------------------
-- Damage records (polymorphic on responsible_type)
--
-- DEVIATION FROM THE v1 ERD, deliberately: the ERD hangs damage off REPEATS
-- only, but incoming cloth inspection happens BEFORE repeat coding, so no repeat
-- exists yet to reference. repeat_id is therefore nullable and order_id/sheet_id
-- are present, which also gives the Order Detail screen its damage query.
--   vendor  -> incoming cloth inspection, order/sheet level   (this phase)
--   worker  -> production collection QA, repeat level         (Phase 5)
--   partner -> finishing return, repeat level                 (Phase 6)
-- ---------------------------------------------------------------------------
create table if not exists public.damage_records (
  id               uuid primary key default gen_random_uuid(),
  factory_id       uuid not null default public.current_factory_id()
                     references public.factories(id) on delete cascade,
  order_id         uuid not null references public.orders(id) on delete cascade,
  sheet_id         uuid references public.sheets(id) on delete set null,
  repeat_id        uuid references public.repeats(id) on delete set null,
  stage_type       text not null,
  damage_type      text not null check (damage_type in ('fabric','stains','cutting','size','other')),
  responsible_type text not null check (responsible_type in ('vendor','worker','partner')),
  responsible_id   uuid,
  deduction        numeric(12,2) not null default 0 check (deduction >= 0),
  approved_by      uuid references public.profiles(id) on delete set null,
  approved_at      timestamptz,
  photo_url        text,
  note             text,
  reported_by      uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_damage_order on public.damage_records(order_id);
create index if not exists idx_damage_repeat on public.damage_records(repeat_id);
create index if not exists idx_damage_factory on public.damage_records(factory_id, responsible_type);

-- Worker/partner damage must name a repeat; vendor damage predates repeats.
alter table public.damage_records drop constraint if exists damage_repeat_required_chk;
alter table public.damage_records add constraint damage_repeat_required_chk
  check (responsible_type = 'vendor' or repeat_id is not null);

-- ---------------------------------------------------------------------------
-- Minimal Inventory & Procurement tables.
-- Phase 3 only needs these to run the thread check and drop an auto-PO row on
-- shortfall. Phase 4 builds the PO/GRN/material-issue screens on top.
-- ---------------------------------------------------------------------------

create table if not exists public.thread_stock (
  id               uuid primary key default gen_random_uuid(),
  factory_id       uuid not null default public.current_factory_id()
                     references public.factories(id) on delete cascade,
  color_code       text not null,
  quantity_meters  numeric(14,2) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (factory_id, color_code)
);

create table if not exists public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  po_code      text not null,
  order_id     uuid references public.orders(id) on delete set null,
  supplier_id  uuid references public.suppliers(id) on delete set null,
  status       text not null default 'auto_generated' check (status in (
                 'auto_generated','issued','awaiting_approval','approved','paid','received','cancelled'
               )),
  auto_created boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists uq_po_code on public.purchase_orders(po_code);
create index if not exists idx_po_order on public.purchase_orders(order_id);

create table if not exists public.po_items (
  id                uuid primary key default gen_random_uuid(),
  factory_id        uuid not null default public.current_factory_id()
                      references public.factories(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  color_code        text not null,
  quantity_meters   numeric(14,2) not null check (quantity_meters > 0),
  created_at        timestamptz not null default now()
);

create index if not exists idx_po_items_po on public.po_items(purchase_order_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['orders','repeats','job_cards','thread_stock','purchase_orders']
  loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', t, t);
    execute format(
      'create trigger trg_%s_touch before update on public.%I
         for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: enabled on every table, day one.
-- ---------------------------------------------------------------------------
alter table public.factory_counters     enable row level security;
alter table public.orders               enable row level security;
alter table public.order_stages         enable row level security;
alter table public.sheets               enable row level security;
alter table public.repeats              enable row level security;
alter table public.repeat_stage_history enable row level security;
alter table public.job_cards            enable row level security;
alter table public.job_card_lines       enable row level security;
alter table public.damage_records       enable row level security;
alter table public.thread_stock         enable row level security;
alter table public.purchase_orders      enable row level security;
alter table public.po_items             enable row level security;

-- factory_counters is internal bookkeeping: no direct client access at all.
-- The SECURITY DEFINER functions in 0008 are the only things that touch it.
drop policy if exists factory_counters_none on public.factory_counters;
create policy factory_counters_none on public.factory_counters
  for select to authenticated using (false);

-- ---------------------------------------------------------------------------
-- Read policies.
--
-- The spine is shared operational data: every role inside the factory needs to
-- read it (a delivery person must see the repeat, an accountant the order). So
-- SELECT is factory-scoped + module-gated, and WRITES are the restricted part —
-- and writes go through the SECURITY DEFINER functions in 0008, which enforce
-- role and state-machine rules that a policy alone cannot express.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'orders','order_stages','sheets','repeats','repeat_stage_history',
    'job_cards','job_card_lines','damage_records'
  ]
  loop
    execute format('drop policy if exists %s_select on public.%I', t, t);
    execute format($f$
      create policy %s_select on public.%I
        for select to authenticated
        using (
          (factory_id = public.current_factory_id()
           and public.module_enabled('order_lifecycle'))
          or public.is_super_admin()
        )
    $f$, t, t);
  end loop;

  foreach t in array array['thread_stock','purchase_orders','po_items']
  loop
    execute format('drop policy if exists %s_select on public.%I', t, t);
    execute format($f$
      create policy %s_select on public.%I
        for select to authenticated
        using (
          (factory_id = public.current_factory_id()
           and public.module_enabled('inventory_procurement'))
          or public.is_super_admin()
        )
    $f$, t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Direct write policies.
--
-- Deliberately narrow. Business transitions are performed by the RPCs in 0008
-- (which run as SECURITY DEFINER and do their own role checks), so the only
-- direct writes permitted here are the order taker's edits to a DRAFT order —
-- the one place a plain CRUD screen is the right tool.
--
-- Note the absence of any UPDATE/DELETE policy on repeat_stage_history: it is
-- append-only by construction, and even inserts are funnelled through 0008.
-- ---------------------------------------------------------------------------

drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders
  for insert to authenticated
  with check (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
    and public.has_any_role(array['company_admin','order_taker'])
    and status = 'draft'
  );

drop policy if exists orders_update_draft on public.orders;
create policy orders_update_draft on public.orders
  for update to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
    and public.has_any_role(array['company_admin','order_taker'])
    and status = 'draft'           -- once submitted, the order taker is read-only
  )
  with check (factory_id = public.current_factory_id() and status = 'draft');

drop policy if exists orders_delete_draft on public.orders;
create policy orders_delete_draft on public.orders
  for delete to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.has_any_role(array['company_admin','order_taker'])
    and status = 'draft'
  );

-- Sheets follow the parent order: editable only while it is a draft.
drop policy if exists sheets_write on public.sheets;
create policy sheets_write on public.sheets
  for all to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
    and public.has_any_role(array['company_admin','order_taker'])
    and exists (select 1 from public.orders o where o.id = order_id and o.status = 'draft')
  )
  with check (
    factory_id = public.current_factory_id()
    and exists (select 1 from public.orders o where o.id = order_id and o.status = 'draft')
  );
