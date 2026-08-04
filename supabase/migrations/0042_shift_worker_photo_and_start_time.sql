-- =============================================================================
-- Factory ERP — Start shift: worker photo + reported start time (Stage 7).
--
-- Two additions to `fm_open_shift`, both additive to the existing flow:
--
-- 1. WORKER PHOTO. An identity/attendance photo, distinct from the machine
--    counter-panel photo this function already requires — that one is a stitch
--    baseline for payroll, this one is "this worker is physically here." Do
--    not conflate the two; both are now required.
--
-- 2. REPORTED START TIME. The spec wants a manually-picked shift start time in
--    the UI. This is deliberately NOT written into `shifts.opened_at`:
--    `0025_report_functions.sql`'s machine-hours/leakage report computes
--    `closed_at - opened_at` as the shift's span in minutes, and
--    `acct_machine_summary` (reconciled in verify-tenancy section 27-ish)
--    depends on that span matching real elapsed time. Letting a manually
--    picked value flow into `opened_at` would corrupt that report the moment
--    someone picked a time that wasn't the actual wall-clock start. Instead
--    `opened_at` keeps its existing `default now()` behaviour untouched, and
--    the picked time is recorded separately as `reported_start_time` —
--    display/record only, never read by payroll or reporting.
-- =============================================================================

alter table public.shifts
  add column if not exists worker_photo_url text,
  add column if not exists reported_start_time timestamptz;

-- Signature is changing (5 args -> 7); without an explicit drop the old
-- 5-argument overload would stay callable and bypass the new requirements.
drop function if exists public.fm_open_shift(uuid, uuid, uuid, text, int);

create or replace function public.fm_open_shift(
  p_machine_id           uuid,
  p_worker_id            uuid,
  p_order_id             uuid,
  p_open_photo_url       text,
  p_open_stitches        int default 0,
  p_worker_photo_url     text default null,
  p_reported_start_time  timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_machine public.machines;
  v_shift_id uuid;
begin
  perform public.assert_role(array['floor_manager','company_admin']);
  perform public.assert_module('machine_workforce');

  v_machine := public.assert_my_machine(p_machine_id);

  if public.current_user_role() = 'floor_manager'
     and v_machine.managed_by is distinct from auth.uid() then
    perform public.raise_not_found('Machine not found.');
  end if;

  if exists(select 1 from public.shifts where machine_id = p_machine_id and status = 'open') then
    raise exception 'This machine already has an open shift.' using errcode = '22023';
  end if;

  if not exists(
    select 1 from public.profiles
     where id = p_worker_id and factory_id = v_factory and role = 'worker' and is_active
  ) then
    raise exception 'Worker not found or inactive.' using errcode = '22023';
  end if;

  if p_order_id is not null then
    perform public.assert_my_order(p_order_id);
  end if;

  if coalesce(trim(p_open_photo_url), '') = '' then
    raise exception 'Open panel photo is required.' using errcode = '22023';
  end if;
  if coalesce(trim(p_worker_photo_url), '') = '' then
    raise exception 'A photo of the worker is required to open a shift.' using errcode = '22023';
  end if;

  insert into public.shifts
    (factory_id, machine_id, worker_id, order_id,
     open_panel_photo_url, open_stitches, status, opened_by,
     worker_photo_url, reported_start_time)
  values
    (v_factory, p_machine_id, p_worker_id, p_order_id,
     p_open_photo_url, coalesce(p_open_stitches, 0), 'open', auth.uid(),
     p_worker_photo_url, coalesce(p_reported_start_time, now()))
  returning id into v_shift_id;

  return v_shift_id;
end $$;

grant execute on function public.fm_open_shift(uuid, uuid, uuid, text, int, text, timestamptz) to authenticated;
