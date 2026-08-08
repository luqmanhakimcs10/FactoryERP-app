-- =============================================================================
-- Factory ERP — schema for the Store Manager restructure.
--
--   * a PO can be tagged to one procurement person
--   * a machine can say which colours are mounted on it right now
--   * every material request is a row, whichever of the two paths made it
--   * a Floor Manager handover records what came back, to one decimal cone
--
-- WHY material_requests IS A TABLE AND NOT A FLAG
-- -----------------------------------------------
-- Today a request is `job_cards.material_requested_at is not null` — a flag on
-- the thing being requested FOR. That worked while a request could only ever
-- come from a job card. The brief adds a second source (stock was sufficient at
-- design-sheet completion, so the floor is told to come and collect) which has
-- no job card at all, and asks for both in one history with a status each. A
-- flag on job_cards cannot represent a request that has no job card, so the
-- request becomes its own row.
--
-- The flag is NOT removed. `fm_ask_for_material` still sets it and the existing
-- issue queue still reads it; this migration backfills a row per flag and keeps
-- the two in step from one function. Dropping the flag would mean rewriting the
-- material-issue queue, the Floor Manager's job-card screen and their tenancy
-- assertions in the same change that introduces the table — more risk than the
-- redundancy costs. The table is the history; the flag stays the gate.
--
-- WHO EACH REQUEST IS FOR
-- -----------------------
--   origin = 'job_card'         -> the STORE MANAGER, who must issue material
--   origin = 'auto_stock_ready' -> the FLOOR MANAGER, told stock is already there
--
-- These are genuinely different jobs, so `directed_to` is stored rather than
-- inferred at every call site. It also keeps the Store Manager's existing
-- "material requests waiting" banner counting only what they must act on: the
-- new auto requests are not their work and must not inflate it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. A manually created PO can name its procurement person
-- ---------------------------------------------------------------------------
alter table public.purchase_orders
  add column if not exists assigned_procurement_user_id uuid
    references public.profiles(id) on delete set null,
  add column if not exists created_by uuid
    references public.profiles(id) on delete set null;

create index if not exists idx_po_assigned
  on public.purchase_orders (factory_id, assigned_procurement_user_id)
  where assigned_procurement_user_id is not null;

-- ---------------------------------------------------------------------------
-- 2. What is mounted on a machine right now
--
-- A join table, not a column on `machines`: a machine carries several colours at
-- once (one per needle head), so a single mounted_item_id could not represent
-- the real thing. Open-ended rows — `unmounted_at is null` means "on the machine
-- now" — so the history of what ran on which machine survives, which is what
-- makes a leakage figure explainable later.
-- ---------------------------------------------------------------------------
create table if not exists public.machine_mounted_items (
  id                uuid primary key default gen_random_uuid(),
  factory_id        uuid not null default public.current_factory_id()
                      references public.factories(id) on delete cascade,
  machine_id        uuid not null references public.machines(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  -- What put it there: the material issue for that machine's active job card.
  job_card_id       uuid references public.job_cards(id) on delete set null,
  quantity          numeric(14,2) not null default 0 check (quantity >= 0),
  mounted_at        timestamptz not null default now(),
  mounted_by        uuid references public.profiles(id) on delete set null,
  unmounted_at      timestamptz,
  created_at        timestamptz not null default now()
);

-- One live mount per machine+item. A second issue of the same colour to the same
-- machine tops up the existing row rather than creating a duplicate the UI would
-- then show twice.
create unique index if not exists uq_machine_mount_live
  on public.machine_mounted_items (machine_id, inventory_item_id)
  where unmounted_at is null;

create index if not exists idx_mounts_factory_machine
  on public.machine_mounted_items (factory_id, machine_id)
  where unmounted_at is null;

-- ---------------------------------------------------------------------------
-- 3. Material requests — both paths, one history
-- ---------------------------------------------------------------------------
create table if not exists public.material_requests (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  request_code text not null,
  order_id     uuid not null references public.orders(id) on delete cascade,
  -- Null for an auto request: stock was checked at design-sheet completion,
  -- which happens before any job card exists.
  job_card_id  uuid references public.job_cards(id) on delete cascade,
  origin       text not null check (origin in ('job_card','auto_stock_ready')),
  directed_to  text not null check (directed_to in ('store_manager','floor_manager')),
  status       text not null default 'pending'
                 check (status in ('pending','issued','completed','cancelled')),
  -- Set when the store manager issues against it.
  material_issue_id uuid references public.material_issues(id) on delete set null,
  note         text,
  requested_by uuid references public.profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

create unique index if not exists uq_material_request_code
  on public.material_requests (request_code);
-- One open request per job card, mirroring `uq_issue_job_card`: two open
-- requests would let the same material be issued twice.
create unique index if not exists uq_material_request_job_card
  on public.material_requests (job_card_id)
  where job_card_id is not null;
create unique index if not exists uq_material_request_auto_order
  on public.material_requests (order_id)
  where origin = 'auto_stock_ready';
create index if not exists idx_material_requests_factory
  on public.material_requests (factory_id, status, requested_at desc);

-- ---------------------------------------------------------------------------
-- 4. Floor Manager handover — what went out, what came back
--
-- Split into header + items for the same reason every other document here is:
-- the leftover figures have to be attributable line by line, because each one
-- becomes a signed stock movement.
-- ---------------------------------------------------------------------------
create table if not exists public.fm_handovers (
  id            uuid primary key default gen_random_uuid(),
  factory_id    uuid not null default public.current_factory_id()
                  references public.factories(id) on delete cascade,
  handover_code text not null,
  order_id      uuid not null references public.orders(id) on delete cascade,
  job_card_id   uuid references public.job_cards(id) on delete set null,
  handed_over_by uuid references public.profiles(id) on delete set null,
  handed_over_at timestamptz not null default now(),
  note          text,
  created_at    timestamptz not null default now()
);

create unique index if not exists uq_fm_handover_code on public.fm_handovers (handover_code);
-- One handover per order: a second would double-credit the leftovers.
create unique index if not exists uq_fm_handover_order on public.fm_handovers (order_id);
create index if not exists idx_fm_handovers_factory
  on public.fm_handovers (factory_id, handed_over_at desc);

create table if not exists public.fm_handover_items (
  id                uuid primary key default gen_random_uuid(),
  factory_id        uuid not null default public.current_factory_id()
                      references public.factories(id) on delete cascade,
  fm_handover_id    uuid not null references public.fm_handovers(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  -- Snapshot of what was issued for this order, so the handover stays readable
  -- even after the issue rows age out of the working set.
  issued_quantity   numeric(14,2) not null default 0 check (issued_quantity >= 0),
  -- Decimals are the point: 2.3 cones is two full cones and a part-used third.
  leftover_quantity numeric(14,2) not null default 0 check (leftover_quantity >= 0),
  -- Still mounted on a machine and NOT coming back — recorded, never credited.
  on_machine        boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists idx_fm_handover_items_handover
  on public.fm_handover_items (fm_handover_id);

-- A line cannot both come back and stay on the machine.
alter table public.fm_handover_items drop constraint if exists fm_handover_items_onmachine_chk;
alter table public.fm_handover_items add constraint fm_handover_items_onmachine_chk
  check (not (on_machine and leftover_quantity > 0));

-- ---------------------------------------------------------------------------
-- 5. Sequins: CD rolls -> an actual count
--
-- (yards_per_CD x 914 / size_mm) x 0.8
--
-- 914 mm is a yard; dividing by the sequin diameter gives how many sit along
-- that length, and 0.8 is the usable proportion. The factor lives HERE and
-- nowhere else — a store manager typing "6 CDs" and the audit screen recomputing
-- the same 6 CDs must never reach different numbers, which is exactly what a
-- second copy of this arithmetic in the client would eventually cause.
-- ---------------------------------------------------------------------------
create or replace function public.sequin_count_from_cds(
  p_cd_count     numeric,
  p_size_mm      int,
  p_yards_per_cd numeric default 90
)
returns numeric
language sql immutable as $$
  select case
           when p_cd_count is null or p_size_mm is null or p_size_mm <= 0 then null
           else round(
             p_cd_count * ((coalesce(p_yards_per_cd, 90) * 914.0) / p_size_mm) * 0.8
           )
         end
$$;

comment on function public.sequin_count_from_cds(numeric, int, numeric) is
  'Sequins in a number of CD rolls: (yards_per_CD x 914 / size_mm) x 0.8. '
  'Single definition — the app must call this, never re-implement it.';

-- ---------------------------------------------------------------------------
-- 6. Backfill: one request row per existing job-card request
--
-- Status is reconstructed from what actually happened rather than defaulted to
-- pending, so the new Requests tab opens with a truthful history instead of
-- claiming every past request is still outstanding.
-- ---------------------------------------------------------------------------
alter table public.factory_counters
  add column if not exists request_seq  bigint not null default 0,
  add column if not exists handover_seq bigint not null default 0;

do $$
declare
  r record;
begin
  for r in
    select jc.id as job_card_id, jc.order_id, jc.factory_id,
           jc.material_requested_at,
           mi.id as issue_id, mi.accepted_at
      from public.job_cards jc
      left join public.material_issues mi on mi.job_card_id = jc.id
     where jc.material_requested_at is not null
       and not exists (select 1 from public.material_requests mr where mr.job_card_id = jc.id)
     order by jc.material_requested_at
  loop
    -- Uses the shared counter rather than a loop variable, so the codes minted
    -- here and the ones minted by sm_* from now on come from the same sequence.
    -- A local counter would have restarted the live sequence at 1 and collided
    -- with everything backfilled below.
    insert into public.material_requests
      (factory_id, request_code, order_id, job_card_id, origin, directed_to,
       status, material_issue_id, requested_at, completed_at)
    values (
      r.factory_id,
      public.make_code(r.factory_id, 'MR', public.next_counter(r.factory_id, 'request_seq')),
      r.order_id, r.job_card_id, 'job_card', 'store_manager',
      case
        when r.accepted_at is not null then 'completed'
        when r.issue_id   is not null  then 'issued'
        else 'pending'
      end,
      r.issue_id, r.material_requested_at, r.accepted_at
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Backfill: what is on each machine now
--
-- Reconstructed from accepted material issues whose job card names a machine and
-- whose order has not finished. Without this the "On Machine" section would be
-- empty until the next issue, and would look broken rather than new.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.material_issue_items') is null then return; end if;

  insert into public.machine_mounted_items
    (factory_id, machine_id, inventory_item_id, job_card_id, quantity, mounted_at)
  -- The machine lives on ORDERS, not job_cards (0041 added
  -- `orders.assigned_machine_id`). The job card is still what the mount is
  -- attributed to, which is why both tables are joined.
  select distinct on (o.assigned_machine_id, ii.id)
         mi.factory_id, o.assigned_machine_id, ii.id, jc.id, mii.issued_meters, mi.issued_at
    from public.material_issues mi
    join public.job_cards jc  on jc.id = mi.job_card_id
    join public.orders o      on o.id = mi.order_id
    join public.material_issue_items mii on mii.material_issue_id = mi.id
    join public.inventory_items ii
      on ii.factory_id = mi.factory_id
     and ii.item_type = 'thread'
     and ii.color_code = mii.color_code
   where o.assigned_machine_id is not null
     and mi.accepted_at is not null
     -- Only orders still in flight. 'completed' and 'cancelled' are the real
     -- terminal statuses (see 0026's constraint); there is no 'delivered'.
     and o.status not in ('completed','cancelled')
   order by o.assigned_machine_id, ii.id, mi.issued_at desc
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- 8. RLS — read inside the factory, write only through the RPCs
-- ---------------------------------------------------------------------------
alter table public.machine_mounted_items enable row level security;
alter table public.material_requests     enable row level security;
alter table public.fm_handovers          enable row level security;
alter table public.fm_handover_items     enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'machine_mounted_items','material_requests','fm_handovers','fm_handover_items'
  ]
  loop
    execute format('drop policy if exists %s_select on public.%I', t, t);
    execute format($f$
      create policy %s_select on public.%I
        for select to authenticated
        using (
          factory_id = public.current_factory_id()
          and public.module_enabled('inventory_procurement')
        )
    $f$, t, t);
  end loop;
end $$;
