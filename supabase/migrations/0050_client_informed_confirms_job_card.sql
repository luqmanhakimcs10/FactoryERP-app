-- =============================================================================
-- Factory ERP — Bug fix: "Ask for material" was unreachable in practice.
--
-- Root cause: `fm_ask_for_material` required job_cards.status = 'confirmed',
-- which only ever happened via a separate "vendor confirmation loop" (share
-- with vendor -> vendor confirms / requests changes) that was never part of
-- the spec's button list for this screen (Download, Share on WhatsApp, Client
-- informed, Ask for material) — nothing in the spec ever required that loop.
-- Because that loop was a non-obvious, separate section, floor managers were
-- pressing "Client informed" and then finding no path to "Ask for material" —
-- which blocked every stage downstream (material issue, machine assignment,
-- shift start, production, stage tracking) from ever being reachable.
--
-- Fix: fold the confirm/lock/advance behaviour that used to live in
-- `fm_confirm_job_card` directly into `fm_mark_vendor_informed` ("Client
-- informed"), the first time it's pressed for a given job card. Idempotent:
-- pressing it again after that just re-stamps vendor_informed_at, without
-- re-running the lock/advance logic. `fm_ask_for_material`'s existing
-- status='confirmed' check is therefore satisfied by Client-informed alone —
-- and it now also explicitly requires vendor_informed_at, so the rule is
-- enforced server-side too, not just by hiding the button in the UI.
--
-- `fm_share_job_card` / `fm_confirm_job_card` / `fm_request_job_card_changes`
-- are left in place (unused by the UI from here on) rather than dropped, to
-- avoid any risk to already-shared/confirmed job cards from a prior session.
-- =============================================================================

create or replace function public.fm_mark_vendor_informed(p_order_id uuid)
returns public.job_cards
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_card  public.job_cards;
  v_first uuid;
  r       record;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'Generate the job card first.' using errcode = 'P0002';
  end if;

  if v_card.status <> 'confirmed' then
    update public.job_cards
       set status = 'confirmed', confirmed_at = now(), change_notes = null
     where id = v_card.id;

    update public.orders set status = 'job_card_confirmed' where id = p_order_id;

    select id into v_first from public.order_stages
     where order_id = p_order_id order by sequence limit 1;

    for r in
      select rp.id
        from public.repeats rp
        join public.sheets s on s.id = rp.sheet_id
       where s.order_id = p_order_id
         and rp.current_status in ('coded','awaiting_job_card')
    loop
      perform public.log_repeat_stage(
        r.id, 'ready_for_production', v_first, null, 'Job card confirmed (client informed)'
      );
    end loop;
  end if;

  update public.job_cards
     set vendor_informed_at = now()
   where id = v_card.id
  returning * into v_card;

  return v_card;
end $$;

grant execute on function public.fm_mark_vendor_informed(uuid) to authenticated;

create or replace function public.fm_ask_for_material(p_order_id uuid)
returns public.job_cards
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_card  public.job_cards;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'There is no job card on this order.' using errcode = 'P0002';
  end if;
  if v_card.vendor_informed_at is null then
    raise exception 'Mark the client informed before requesting material.' using errcode = '22023';
  end if;
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
