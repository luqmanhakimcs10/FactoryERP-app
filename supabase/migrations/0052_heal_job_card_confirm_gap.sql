-- =============================================================================
-- Factory ERP — Heal the draft→confirmed dead end left by pre-0050 job cards.
--
-- 0050 folded "confirm" into "Client informed" (fm_mark_vendor_informed): the
-- first press sets vendor_informed_at AND flips status to 'confirmed'. But job
-- cards that had "Client informed" pressed BEFORE 0050 landed are stranded:
-- vendor_informed_at is set while status is still 'draft'/'shared'. The UI
-- disables "Client informed" once vendor_informed_at exists, so there is no
-- press left that would run the confirm branch — a permanent dead end, exactly
-- the gap this whole change set is about.
--
-- Two fixes here:
--   1. Backfill: any job card with vendor_informed_at set but status not yet
--      'confirmed' is confirmed now — same side effects the confirm branch
--      would have had (confirmed_at, order → job_card_confirmed, repeats →
--      ready_for_production).
--   2. fm_ask_for_material drops its separate vendor_informed_at gate. Per the
--      spec there must be exactly ONE gate from draft→confirmed→material:
--      status = 'confirmed'. Cards confirmed via the legacy fm_confirm_job_card
--      path (status confirmed, vendor_informed_at null) were silently blocked
--      by that second check; removing it is what makes 'confirmed' the only
--      condition, as required.
-- =============================================================================

-- ---- 1. Backfill stranded job cards ----------------------------------------
-- Runs as the migration (admin) role, which has no Supabase JWT — so
-- current_factory_id() is null and the auth-scoped log_repeat_stage() helper
-- would raise "Repeat not found." for every row. This is a cross-factory admin
-- backfill, so it writes repeat_stage_history + repeats directly, using each
-- repeat's OWN factory_id (never a session value), mirroring exactly what
-- log_repeat_stage does minus the tenant guard.
do $$
declare
  jc      record;
  v_first uuid;
  r       record;
begin
  for jc in
    select * from public.job_cards
     where vendor_informed_at is not null and status <> 'confirmed'
  loop
    update public.job_cards
       set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()), change_notes = null
     where id = jc.id;

    update public.orders
       set status = 'job_card_confirmed'
     where id = jc.order_id
       and status in ('awaiting_job_card', 'job_card_shared');

    select id into v_first from public.order_stages
     where order_id = jc.order_id order by sequence limit 1;

    if v_first is not null then
      for r in
        select rp.id, rp.factory_id
          from public.repeats rp
          join public.sheets s on s.id = rp.sheet_id
         where s.order_id = jc.order_id
           and rp.current_status in ('coded', 'awaiting_job_card')
      loop
        insert into public.repeat_stage_history
          (factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note)
        values
          (r.factory_id, r.id, v_first, 'ready_for_production', null, null,
           'Job card confirmed (backfill 0052)');

        update public.repeats
           set current_status = 'ready_for_production', updated_at = now()
         where id = r.id;
      end loop;
    end if;
  end loop;
end $$;

-- ---- 2. Ask-for-material keys off 'confirmed' alone ------------------------
create or replace function public.fm_ask_for_material(p_order_id uuid)
returns public.job_cards
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_card  public.job_cards;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'There is no job card on this order.' using errcode = 'P0002';
  end if;
  -- Single gate: the job card must be confirmed. 'Client informed' is the only
  -- path to 'confirmed' now, so the earlier vendor_informed_at check was a
  -- redundant second gate that stranded legacy-confirmed cards — dropped.
  if v_card.status <> 'confirmed' then
    raise exception 'The job card must be confirmed before material can be requested (status: %).', v_card.status
      using errcode = '22023';
  end if;
  if v_card.material_requested_at is not null then
    raise exception 'Material has already been requested for this job card.' using errcode = '22023';
  end if;

  update public.job_cards
     set material_requested_at = now()
   where id = v_card.id
  returning * into v_card;

  return v_card;
end $$;

grant execute on function public.fm_ask_for_material(uuid) to authenticated;
