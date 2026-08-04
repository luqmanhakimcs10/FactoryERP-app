-- =============================================================================
-- Factory ERP — Phase 6: Finishing stages, SLA alerting & final delivery schema
-- =============================================================================

-- 1. Extend orders.status check constraint to include post-job-card states
alter table public.orders
  drop constraint if exists orders_status_check;

alter table public.orders
  add constraint orders_status_check check (status in (
    'draft',
    'awaiting_procurement',
    'awaiting_cloth_inspection',
    'awaiting_coding',
    'awaiting_job_card',
    'job_card_shared',
    'job_card_confirmed',
    'in_production',
    'in_finishing',
    'awaiting_final_qa',
    'ready_for_delivery',
    'completed',
    'cancelled'
  ));

-- 2. Extend repeats.current_status check constraint to include handoff and collection states
alter table public.repeats
  drop constraint if exists repeats_current_status_check;

alter table public.repeats
  add constraint repeats_current_status_check check (current_status in (
    'coded',
    'awaiting_job_card',
    'ready_for_production',
    'in_production',
    'in_finishing',
    'handed_off',
    'awaiting_collection_qa',
    'awaiting_final_qa',
    'completed',
    'damaged'
  ));

-- 3. Extend repeat_stage_history with handoff/return evidence fields
alter table public.repeat_stage_history
  add column if not exists handoff_photo_url text,
  add column if not exists return_photo_url text,
  add column if not exists handed_off_at timestamptz,
  add column if not exists returned_at timestamptz,
  add column if not exists partner_id uuid references public.finishing_partners(id) on delete set null;

create index if not exists idx_rsh_handed_off on public.repeat_stage_history(factory_id, handed_off_at)
  where handed_off_at is not null and returned_at is null;

-- 4. Create sla_alerts table
create table if not exists public.sla_alerts (
  id             uuid primary key default gen_random_uuid(),
  factory_id     uuid not null default public.current_factory_id()
                   references public.factories(id) on delete cascade,
  order_stage_id uuid not null references public.order_stages(id) on delete cascade,
  repeat_id      uuid not null references public.repeats(id) on delete cascade,
  history_id     uuid references public.repeat_stage_history(id) on delete cascade,
  triggered_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- Index for scanning unresolved SLA alerts per tenant
create index if not exists idx_sla_alerts_open on public.sla_alerts(factory_id, resolved_at)
  where resolved_at is null;

-- Uniqueness: only 1 open SLA alert per repeat per stage
create unique index if not exists uq_sla_alerts_open_repeat
  on public.sla_alerts(repeat_id, order_stage_id)
  where resolved_at is null;

-- 5. Extend damage_records fields / delivery photos on orders
alter table public.orders
  add column if not exists delivery_photo_url text,
  add column if not exists delivery_signature_url text,
  add column if not exists delivered_at timestamptz;

-- 6. Enable RLS on sla_alerts
alter table public.sla_alerts enable row level security;

drop policy if exists sla_alerts_select on public.sla_alerts;
create policy sla_alerts_select on public.sla_alerts
  for select to authenticated
  using (
    (factory_id = public.current_factory_id() or public.is_super_admin())
    and public.module_enabled('order_lifecycle')
  );

-- Direct writes to sla_alerts disallowed; managed via SECURITY DEFINER functions / cron scanner.
drop policy if exists sla_alerts_write on public.sla_alerts;
