-- =============================================================================
-- Factory ERP — fix: nothing ever actually got mounted on a machine.
--
-- THE GAP
-- -------
-- 0071 mounts inventory inside `sm_issue_materials`, because the brief says
-- mounting is "driven by material issue against that machine's active job card".
-- Taken at face value that is the right place. In THIS app it can never fire.
--
-- The real order of events is: job card confirmed -> material issued -> floor
-- manager accepts -> order reaches `machine_selection_pending` -> a machine is
-- assigned. Material is always issued BEFORE any machine exists on the order, so
-- `orders.assigned_machine_id` is still null when sm_issue_materials looks, every
-- single time. The mount block was unreachable code and "On Machine" would have
-- stayed permanently empty.
--
-- Caught because verify:store reported `0 mounted item(s)` and I checked whether
-- that was missing data or missing logic. It was logic.
--
-- THE FIX
-- -------
-- Mount when the machine becomes known, which is at assignment. The issue-time
-- block in 0071 is left alone: it is correct for the case where a machine is
-- already assigned (a re-issue, or any future flow that assigns earlier), and
-- both paths funnel through one idempotent function, so neither can produce a
-- duplicate or disagree with the other about quantity.
--
-- Both assignment functions are patched. `fm_assign_machine_with_shift` (0057) is
-- what the app calls today; `fm_assign_machine` (0041) is still reachable from
-- shifts.ts. Fixing only the one in front of me would leave the other silently
-- not mounting — the same class of miss as the grns join in 0073.
--
-- Both bodies are reproduced from their own migration files with one line
-- injected, generated rather than retyped, so nothing else can drift.
-- =============================================================================

/**
 * Make `machine_mounted_items` agree with what has been issued for an order and
 * which machine the order is on.
 *
 * Idempotent by construction: the unique index is one live mount per
 * machine+item, and quantity is SET from the issued total rather than added to,
 * so calling this twice cannot double a mount. That is what lets it be called
 * from both assignment paths and from a re-issue without any of them needing to
 * know whether the others have run.
 *
 * Silent no-op when the order has no machine or no issued material — both are
 * ordinary states, not errors, and raising would block machine assignment for
 * every order whose material has not gone out yet.
 */
create or replace function public.fm_sync_machine_mounts(p_order_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_machine uuid;
  v_card    uuid;
  v_n       int := 0;
begin
  select o.assigned_machine_id into v_machine
    from public.orders o
   where o.id = p_order_id and o.factory_id = v_factory;

  if v_machine is null then
    return 0;
  end if;

  select jc.id into v_card from public.job_cards jc where jc.order_id = p_order_id limit 1;

  -- One row per thread colour issued for this order, at the issued total.
  with issued as (
    select ii.id as item_id, sum(mii.issued_meters)::numeric(14,2) as qty
      from public.material_issues mi
      join public.material_issue_items mii on mii.material_issue_id = mi.id
      join public.inventory_items ii
        on ii.factory_id = mi.factory_id
       and ii.item_type = 'thread'
       and ii.color_code = mii.color_code
     where mi.factory_id = v_factory and mi.order_id = p_order_id
     group by ii.id
  )
  insert into public.machine_mounted_items
    (factory_id, machine_id, inventory_item_id, job_card_id, quantity, mounted_by)
  select v_factory, v_machine, issued.item_id, v_card, issued.qty, auth.uid()
    from issued
  on conflict (machine_id, inventory_item_id) where unmounted_at is null
  do update set quantity    = excluded.quantity,
                job_card_id = excluded.job_card_id;

  select count(*)::int into v_n
    from public.machine_mounted_items mm
   where mm.factory_id = v_factory and mm.machine_id = v_machine and mm.unmounted_at is null;

  return v_n;
end $$;

grant execute on function public.fm_sync_machine_mounts(uuid) to authenticated;

create or replace function public.fm_assign_machine_with_shift(
  p_order_id            uuid,
  p_machine_id          uuid,
  p_worker_id           uuid,
  p_worker_photo_url    text,
  p_reported_start_time timestamptz default null,
  p_open_photo_url      text default null,
  p_open_stitches       int default 0
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory  uuid := public.current_factory_id();
  v_order    public.orders;
  v_machine  public.machines;
  v_shift_id uuid;
  v_reused   boolean := false;
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
  -- Same visibility rule as fm_assign_machine: a floor manager only sees the
  -- machines they manage, and a machine they don't manage must 404, not 403 —
  -- a 403 would confirm the machine exists.
  if public.current_user_role() = 'floor_manager'
     and v_machine.managed_by is distinct from auth.uid() then
    perform public.raise_not_found('Machine not found.');
  end if;

  if coalesce(trim(p_worker_photo_url), '') = '' then
    raise exception 'A photo of the worker is required.' using errcode = '22023';
  end if;

  -- Reuse an already-open shift rather than failing. The Floor Manager pressing
  -- one button should not have to know whether someone already opened this
  -- machine today.
  select id into v_shift_id
    from public.shifts
   where machine_id = p_machine_id and status = 'open'
   limit 1;

  if v_shift_id is not null then
    v_reused := true;
    -- Attach the shift to this order if it was opened without one.
    update public.shifts
       set order_id = coalesce(order_id, p_order_id),
           worker_photo_url = coalesce(worker_photo_url, p_worker_photo_url)
     where id = v_shift_id;
  else
    if not exists (
      select 1 from public.profiles
       where id = p_worker_id and factory_id = v_factory and role = 'worker' and is_active
    ) then
      raise exception 'Select an active worker to open the shift.' using errcode = '22023';
    end if;

    insert into public.shifts
      (factory_id, machine_id, worker_id, order_id,
       open_panel_photo_url, open_stitches, status, opened_by,
       worker_photo_url, reported_start_time)
    values
      (v_factory, p_machine_id, p_worker_id, p_order_id,
       nullif(trim(coalesce(p_open_photo_url, '')), ''), coalesce(p_open_stitches, 0),
       'open', auth.uid(),
       p_worker_photo_url, coalesce(p_reported_start_time, now()))
    returning id into v_shift_id;
  end if;

  update public.orders
     set assigned_machine_id = p_machine_id
   where id = p_order_id;

  -- The machine is only known NOW, so this is where mounting can happen.
  perform public.fm_sync_machine_mounts(p_order_id);

  return jsonb_build_object(
    'order_id',   p_order_id,
    'machine_id', p_machine_id,
    'shift_id',   v_shift_id,
    'reused_shift', v_reused
  );
end $$;

grant execute on function public.fm_assign_machine_with_shift(uuid, uuid, uuid, text, timestamptz, text, int) to authenticated;

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

  perform public.fm_sync_machine_mounts(p_order_id);

  return v_order;
end $$;

grant execute on function public.fm_assign_machine(uuid, uuid) to authenticated;
