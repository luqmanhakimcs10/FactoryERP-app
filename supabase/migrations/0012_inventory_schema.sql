-- =============================================================================
-- Factory ERP — Phase 4: Inventory & Procurement
--
-- THE CENTRAL RULE OF THIS PHASE:
--   `stock_movements` is the unified ledger. EVERY change to thread_stock of any
--   kind writes exactly one row here, in the same transaction as the balance
--   change (see log_stock_movement in 0013). Phase 7's Inventory Consumption &
--   Leakage report has nothing else to read from, so a movement that is missing
--   now cannot be backfilled later.
--
-- Two decisions that make that ledger actually reconstructible:
--
-- 1. QUANTITY IS SIGNED. Receipts are positive, issues negative, an audit
--    variance carries the signed delta. A running sum of movements for a colour
--    therefore equals its current balance exactly — which is the whole point of
--    a ledger, and is what the leakage report needs.
--
-- 2. THERE IS AN 'opening' MOVEMENT TYPE. The brief lists grn|issue|
--    audit_variance, but the opening balance has to live in the ledger too:
--    without it the running sum starts from nothing and can never reconcile to
--    the real balance. Recording opening stock as a 'grn' would be worse — it
--    would look like a supplier receipt in the leakage report.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extend Phase 3's purchase_orders for the execution flow.
-- ---------------------------------------------------------------------------
alter table public.purchase_orders
  add column if not exists bill_url     text,
  add column if not exists executed_at  timestamptz,
  add column if not exists executed_by  uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at  timestamptz,
  add column if not exists approved_by  uuid references public.profiles(id) on delete set null,
  add column if not exists paid_at      timestamptz,
  add column if not exists paid_by      uuid references public.profiles(id) on delete set null,
  add column if not exists amount       numeric(14,2),
  add column if not exists notes        text;

-- The Phase 3 status set only covered creation. Replace it with the full
-- execution lifecycle.
alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check
  check (status in (
    'auto_generated',      -- raised by Phase 3's shortfall check
    'draft',               -- created manually by procurement
    'executed',            -- placed with the supplier
    'awaiting_approval',   -- supplier bill uploaded; owner acts in Phase 7
    'approved',            -- owner approved the expense (Phase 7 UI)
    'paid',                -- accountant recorded payment (Phase 7 UI)
    'handed_over',         -- physically handed to the store manager
    'received',            -- store manager confirmed the GRN
    'cancelled'
  ));

-- po_items: Phase 3 created (color_code, quantity_meters). Add a free-text
-- description so a PO can carry non-thread lines (needles, backing, etc.).
alter table public.po_items
  add column if not exists description text;

-- Thread lines credit stock by colour; non-thread lines only need a description.
alter table public.po_items alter column color_code drop not null;
alter table public.po_items drop constraint if exists po_items_identity_chk;
alter table public.po_items add constraint po_items_identity_chk
  check (color_code is not null or description is not null);

-- One-time opening stock: an explicit flag, not "is thread_stock empty".
-- Emptiness is not a safe test — a factory could delete rows years in and
-- silently re-open the entry, overwriting real counts.
alter table public.factories
  add column if not exists opening_stock_completed_at timestamptz,
  add column if not exists opening_stock_completed_by uuid references public.profiles(id) on delete set null;

alter table public.thread_stock
  alter column factory_id set default public.current_factory_id();

-- ---------------------------------------------------------------------------
-- Goods Received Notes
-- ---------------------------------------------------------------------------
create table if not exists public.grns (
  id                uuid primary key default gen_random_uuid(),
  factory_id        uuid not null default public.current_factory_id()
                      references public.factories(id) on delete cascade,
  grn_code          text not null,
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  status            text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  handed_over_by    uuid references public.profiles(id) on delete set null,
  handed_over_at    timestamptz not null default now(),
  confirmed_by      uuid references public.profiles(id) on delete set null,
  confirmed_at      timestamptz,
  note              text,
  created_at        timestamptz not null default now()
);

create unique index if not exists uq_grn_code on public.grns(grn_code);
create index if not exists idx_grns_factory_status on public.grns(factory_id, status);

-- Expected vs actually-received quantity: a short delivery must be recordable,
-- and only the received amount may ever touch stock.
create table if not exists public.grn_items (
  id                uuid primary key default gen_random_uuid(),
  factory_id        uuid not null default public.current_factory_id()
                      references public.factories(id) on delete cascade,
  grn_id            uuid not null references public.grns(id) on delete cascade,
  color_code        text,
  description       text,
  expected_meters   numeric(14,2) not null default 0,
  received_meters   numeric(14,2) not null default 0 check (received_meters >= 0),
  created_at        timestamptz not null default now()
);

create index if not exists idx_grn_items_grn on public.grn_items(grn_id);

-- ---------------------------------------------------------------------------
-- Material issue against a confirmed job card
-- ---------------------------------------------------------------------------
create table if not exists public.material_issues (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  issue_code   text not null,
  job_card_id  uuid not null references public.job_cards(id) on delete cascade,
  order_id     uuid not null references public.orders(id) on delete cascade,
  issued_by    uuid references public.profiles(id) on delete set null,
  issued_at    timestamptz not null default now(),
  note         text,
  created_at   timestamptz not null default now()
);

create unique index if not exists uq_issue_code on public.material_issues(issue_code);
-- One issue per job card: re-issuing would double-deduct stock.
create unique index if not exists uq_issue_job_card on public.material_issues(job_card_id);
create index if not exists idx_issues_factory on public.material_issues(factory_id);

create table if not exists public.material_issue_items (
  id                 uuid primary key default gen_random_uuid(),
  factory_id         uuid not null default public.current_factory_id()
                       references public.factories(id) on delete cascade,
  material_issue_id  uuid not null references public.material_issues(id) on delete cascade,
  color_code         text not null,
  required_meters    numeric(14,2) not null default 0,
  issued_meters      numeric(14,2) not null default 0 check (issued_meters >= 0),
  created_at         timestamptz not null default now()
);

create index if not exists idx_issue_items_issue on public.material_issue_items(material_issue_id);

-- ---------------------------------------------------------------------------
-- Weekly stock audit
-- ---------------------------------------------------------------------------
create table if not exists public.stock_audits (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null default public.current_factory_id()
                 references public.factories(id) on delete cascade,
  audit_code   text not null,
  audit_date   date not null default current_date,
  conducted_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz not null default now(),
  note         text,
  created_at   timestamptz not null default now()
);

create unique index if not exists uq_audit_code on public.stock_audits(audit_code);
create index if not exists idx_audits_factory on public.stock_audits(factory_id, audit_date desc);

create table if not exists public.stock_audit_items (
  id              uuid primary key default gen_random_uuid(),
  factory_id      uuid not null default public.current_factory_id()
                    references public.factories(id) on delete cascade,
  stock_audit_id  uuid not null references public.stock_audits(id) on delete cascade,
  color_code      text not null,
  expected_meters numeric(14,2) not null,
  actual_meters   numeric(14,2) not null check (actual_meters >= 0),
  -- Stored, not derived: the expected figure is a point-in-time snapshot, and
  -- the variance must stay exactly what was signed off even as stock moves on.
  variance_meters numeric(14,2) not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_audit_items_audit on public.stock_audit_items(stock_audit_id);

-- ---------------------------------------------------------------------------
-- THE UNIFIED STOCK LEDGER
--
-- Append-only. One row per stock change, always written in the same transaction
-- as the balance update. `ref_type`/`ref_id` point back at the cause (GRN,
-- material issue, audit) so any movement can be traced to the event that made it.
-- ---------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  factory_id      uuid not null default public.current_factory_id()
                    references public.factories(id) on delete cascade,
  thread_stock_id uuid not null references public.thread_stock(id) on delete cascade,
  -- Denormalized so the ledger stays readable even if a stock row is ever
  -- reorganised, and so the leakage report can group without a join.
  color_code      text not null,
  movement_type   text not null check (movement_type in ('opening','grn','issue','audit_variance')),
  -- SIGNED. + receipt, - consumption, ± audit correction.
  quantity_meters numeric(14,2) not null,
  balance_after   numeric(14,2) not null,
  actor_user_id   uuid references public.profiles(id) on delete set null,
  ref_type        text check (ref_type in ('grn','material_issue','stock_audit','opening')),
  ref_id          uuid,
  note            text,
  created_at      timestamptz not null default now()
);

-- Sign must match the movement's meaning, so a mis-signed row can't corrupt the
-- running balance the leakage report depends on.
alter table public.stock_movements drop constraint if exists stock_movements_sign_chk;
alter table public.stock_movements add constraint stock_movements_sign_chk
  check (
    (movement_type = 'grn'     and quantity_meters > 0)
    or (movement_type = 'issue'   and quantity_meters < 0)
    or (movement_type = 'opening' and quantity_meters >= 0)
    or  movement_type = 'audit_variance'   -- may be either direction, or zero
  );

create index if not exists idx_movements_factory_color
  on public.stock_movements(factory_id, color_code, created_at);
create index if not exists idx_movements_ref on public.stock_movements(ref_type, ref_id);
create index if not exists idx_movements_stock on public.stock_movements(thread_stock_id, created_at);

-- updated_at trigger for the new mutable table
drop trigger if exists trg_thread_stock_touch on public.thread_stock;
create trigger trg_thread_stock_touch before update on public.thread_stock
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.grns                 enable row level security;
alter table public.grn_items            enable row level security;
alter table public.material_issues      enable row level security;
alter table public.material_issue_items enable row level security;
alter table public.stock_audits         enable row level security;
alter table public.stock_audit_items    enable row level security;
alter table public.stock_movements      enable row level security;

-- Reads: anyone in the factory with the Inventory & Procurement module.
-- Writes: none directly — every mutation goes through the SECURITY DEFINER RPCs
-- in 0013, which enforce role and state-machine rules a policy cannot express.
-- Note the deliberate absence of any write policy on stock_movements: the ledger
-- is append-only by construction and unforgeable from a client.
do $$
declare t text;
begin
  foreach t in array array[
    'grns','grn_items','material_issues','material_issue_items',
    'stock_audits','stock_audit_items','stock_movements'
  ]
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
