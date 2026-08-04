-- =============================================================================
-- Factory ERP — Machine assignment (Stage 6).
--
-- New order status `machine_selection_pending`, sitting right after inventory
-- is accepted (0040) and before production starts (0043). Machine assignment
-- is per-order (confirmed decision), not per-repeat — every repeat in an order
-- shares one machine, consistent with shift-open already being machine +
-- worker + order together.
--
-- Assigning a machine does NOT by itself advance the order past
-- machine_selection_pending — it only records which machine. The order only
-- leaves this status when "Start production" (0043) runs, which asserts a
-- machine is assigned AND that machine currently has an open shift.
-- =============================================================================

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in (
    'draft',
    'awaiting_procurement',
    'awaiting_cloth_inspection',
    'awaiting_coding',
    'awaiting_job_card',
    'job_card_shared',
    'job_card_confirmed',
    'machine_selection_pending',
    'in_production',
    'in_finishing',
    'awaiting_final_qa',
    'ready_for_delivery',
    'completed',
    'cancelled'
  ));

alter table public.orders
  add column if not exists assigned_machine_id uuid references public.machines(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Once inventory is accepted, the order is ready for machine selection.
-- Idempotent: a second material issue accepted on the same order (or a retry)
-- is a no-op on the order's status once it has already moved past this point.
-- ---------------------------------------------------------------------------
create or replace function public.fm_accept_inventory(
  p_material_issue_id uuid,
  p_photo_url          text
)
returns public.material_issues
language plpgsql security definer set search_path = public as $$
declare
  v_issue public.material_issues;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the received materials is required.' using errcode = '22023';
  end if;

  select * into v_issue from public.material_issues where id = p_material_issue_id;
  if not found or v_issue.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Material issue not found.');
  end if;
  if v_issue.accepted_at is not null then
    raise exception 'This material issue has already been accepted.' using errcode = '22023';
  end if;

  update public.material_issues
     set accepted_by = auth.uid(), accepted_at = now(), accepted_photo_url = p_photo_url
   where id = p_material_issue_id
  returning * into v_issue;

  update public.orders
     set status = 'machine_selection_pending'
   where id = v_issue.order_id
     and status = 'job_card_confirmed';

  return v_issue;
end $$;

-- ---------------------------------------------------------------------------
-- Assign a machine. Refused unless the machine currently has an open shift —
-- the UI surfaces that same rule as the "Assign a machine" modal's guidance.
-- ---------------------------------------------------------------------------
create or replace function public.fm_assign_machine(
  p_order_id   uuid,
  p_machine_id uuid
)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_machine public.machines;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  v_order := public.assert_my_order(p_order_id);
  if v_order.status <> 'machine_selection_pending' then
    raise exception 'This order is not awaiting machine selection (status: %).', v_order.status
      using errcode = '22023';
  end if;

  v_machine := public.assert_my_machine(p_machine_id);
  if public.current_user_role() = 'floor_manager'
     and v_machine.managed_by is distinct from auth.uid() then
    perform public.raise_not_found('Machine not found.');
  end if;

  if not exists (
    select 1 from public.shifts where machine_id = p_machine_id and status = 'open'
  ) then
    raise exception 'This machine does not currently have an active shift.' using errcode = '22023';
  end if;

  update public.orders
     set assigned_machine_id = p_machine_id
   where id = p_order_id
  returning * into v_order;

  return v_order;
end $$;

-- ---------------------------------------------------------------------------
-- Shift Calendar: per-machine shift state for a given date. A shift "belongs"
-- to the date it was opened on — this keeps the read simple and matches the
-- calendar's own framing (per-machine Open/Close shift, per day), rather than
-- trying to represent a shift spanning midnight as live on two dates.
-- ---------------------------------------------------------------------------
create or replace function public.fm_shifts_for_date(p_date date)
returns table (
  machine_id   uuid,
  machine_name text,
  shift_id     uuid,
  status       text,
  worker_name  text,
  order_code   text,
  opened_at    timestamptz,
  closed_at    timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_role(array['floor_manager', 'company_admin']);
  perform public.assert_module('machine_workforce');

  return query
  select
    m.id, m.name,
    s.id, s.status, wp.display_name, o.order_code, s.opened_at, s.closed_at
  from public.machines m
  left join lateral (
    select sh.* from public.shifts sh
     where sh.machine_id = m.id
       and sh.opened_at::date = p_date
     order by sh.opened_at desc
     limit 1
  ) s on true
  left join public.profiles wp on wp.id = s.worker_id
  left join public.orders o on o.id = s.order_id
  where m.factory_id = public.current_factory_id()
    and m.deleted_at is null
    and (
      public.current_user_role() = 'company_admin'
      or m.managed_by = auth.uid()
      or m.managed_by is null
    )
  order by m.name;
end $$;

grant execute on function public.fm_accept_inventory(uuid, text) to authenticated;
grant execute on function public.fm_assign_machine(uuid, uuid) to authenticated;
grant execute on function public.fm_shifts_for_date(date) to authenticated;
