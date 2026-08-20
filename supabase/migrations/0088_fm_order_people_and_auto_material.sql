-- =============================================================================
-- Factory ERP — Floor Manager: "Client Approved" requests material by itself,
-- and the Order Details tab gets something to read.
--
-- TWO CHANGES, BOTH SMALL, BOTH ABOUT REMOVING A STEP:
--
--   1. `fm_mark_vendor_informed` now ALSO stamps `material_requested_at`.
--      "Client informed" and "Ask for material" were two presses for one
--      decision — the second one existed only because the first did not do it,
--      and a job card that was confirmed but never "asked" sat looking finished
--      while the store manager's Material Requests list stayed empty.
--
--   2. `fm_order_people` answers "who touched this order, and when" in one
--      call, for the Order Details tab. Every row is derived from history that
--      already exists; nothing new is recorded to support it.
--
-- WHAT IS *NOT* HERE: the stage-sequence defaults. The job card builder stopped
-- asking for handled-by and SLA per stage, but `fm_set_stage_sequence` still
-- takes them and is still the only writer, so the defaults are applied by the
-- caller (stage 1 in-house, later stages outsourced, 24h SLA) rather than being
-- baked into the RPC. That keeps one writer with one shape, and leaves the
-- door open for a screen that does want to set them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Client Approved requests the material
-- ---------------------------------------------------------------------------
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
        r.id, 'ready_for_production', v_first, null, 'Job card confirmed (client approved)'
      );
    end loop;
  end if;

  update public.job_cards
     set vendor_informed_at = now(),
         -- The material request, folded in. `coalesce` rather than `now()`
         -- outright: pressing an already-approved card again must not reset the
         -- stamp, and a card whose material was requested the old way (before
         -- this migration) keeps its original time.
         material_requested_at = coalesce(material_requested_at, now())
   where id = v_card.id
  returning * into v_card;

  return v_card;
end $$;

grant execute on function public.fm_mark_vendor_informed(uuid) to authenticated;

-- `fm_ask_for_material` is NOT dropped. It has no caller now that the button is
-- gone, but it is the only thing that can request material for a job card
-- confirmed before this migration — those cards have `vendor_informed_at` set
-- and `material_requested_at` null, and pressing Client Approved again would be
-- refused as a no-op. Section 3 backfills them instead; the function stays as
-- the manual repair for any that arrive later.

-- ---------------------------------------------------------------------------
-- 2. Who touched this order, and when
--
-- One row per person/thing involved, ordered by when they got involved. The
-- Order Details tab renders it as a list and needs no per-role query of its own.
--
-- `at` is the FIRST time that party touched the order, not the last: the tab
-- answers "who has been involved", and a running timestamp would make a partner
-- who finished last week look like they are still working.
-- ---------------------------------------------------------------------------
create or replace function public.fm_order_people(p_order_id uuid)
returns table (
  role_key   text,
  role_label text,
  person     text,
  detail     text,
  at         timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','qa','company_admin']);

  if not exists (
    select 1 from public.orders o where o.id = p_order_id and o.factory_id = v_factory
  ) then
    perform public.raise_not_found('Order not found.');
  end if;

  -- Each party is its own RETURN QUERY rather than one UNION: several of these
  -- need their own ORDER BY / LIMIT (the FIRST coder, not every coder), and a
  -- LIMIT on a union applies to the whole result — which would have silently
  -- dropped every row after the first.

  -- Order taker: who captured it.
  return query
  select 'order_taker', 'Order taker',
         coalesce(p.display_name, 'Unknown'),
         o.order_code,
         coalesce(o.submitted_at, o.created_at)
    from public.orders o
    left join public.profiles p on p.id = o.created_by
   where o.id = p_order_id;

  -- QA: whoever coded the first piece.
  return query
  select 'qa', 'QA', coalesce(pr.display_name, 'Unknown'), null::text, h.created_at
    from public.repeat_stage_history h
    join public.repeats rp on rp.id = h.repeat_id
    join public.sheets s on s.id = rp.sheet_id
    left join public.profiles pr on pr.id = h.actor_user_id
   where s.order_id = p_order_id and h.status = 'coded'
     and h.actor_user_id is not null
   order by h.created_at
   limit 1;

  -- Floor manager: whoever confirmed the job card.
  return query
  select 'floor_manager', 'Floor manager',
         coalesce(pr.display_name, 'Unknown'),
         'Job card ' || coalesce(jc.design_code, 'confirmed'),
         jc.confirmed_at
    from public.job_cards jc
    left join lateral (
      select h.actor_user_id
        from public.repeat_stage_history h
        join public.repeats rp on rp.id = h.repeat_id
        join public.sheets s on s.id = rp.sheet_id
       where s.order_id = p_order_id and h.status = 'ready_for_production'
       order by h.created_at
       limit 1
    ) fm on true
    left join public.profiles pr on pr.id = fm.actor_user_id
   where jc.order_id = p_order_id and jc.confirmed_at is not null;

  -- Machine: the one this order was mounted on.
  return query
  select 'machine', 'Machine', m.name,
         null::text,
         (select min(h.created_at)
            from public.repeat_stage_history h
            join public.repeats rp on rp.id = h.repeat_id
            join public.sheets s on s.id = rp.sheet_id
           where s.order_id = p_order_id and h.status = 'in_production')
    from public.orders o
    join public.machines m on m.id = o.assigned_machine_id
   where o.id = p_order_id;

  -- Delivery people: everyone who has carried a piece of this order.
  return query
  select 'delivery', 'Delivery person', pr.display_name,
         count(*)::text || ' movement' || case when count(*) = 1 then '' else 's' end,
         min(h.created_at)
    from public.repeat_stage_history h
    join public.repeats rp on rp.id = h.repeat_id
    join public.sheets s on s.id = rp.sheet_id
    join public.profiles pr on pr.id = h.actor_user_id
   where s.order_id = p_order_id
     and pr.role in ('delivery', 'order_delivery')
   group by pr.display_name;

  -- Finishing partners: from the stage plan AND from what actually happened,
  -- because a stage can be handed to a partner the plan never named.
  return query
  select 'finishing_partner', 'Finishing partner', fp.name,
         string_agg(distinct replace(x.stage_type, '_', ' '), ', '),
         min(x.at)
    from (
      select os.partner_id, os.stage_type, jc.confirmed_at as at
        from public.order_stages os
        left join public.job_cards jc on jc.order_id = os.order_id
       where os.order_id = p_order_id and os.partner_id is not null
      union all
      select h.partner_id,
             coalesce(os2.stage_type, 'stage'),
             h.created_at
        from public.repeat_stage_history h
        join public.repeats rp on rp.id = h.repeat_id
        join public.sheets s on s.id = rp.sheet_id
        left join public.order_stages os2 on os2.id = h.order_stage_id
       where s.order_id = p_order_id and h.partner_id is not null
    ) x
    join public.finishing_partners fp on fp.id = x.partner_id
   group by fp.name;
end $$;

grant execute on function public.fm_order_people(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Backfill: job cards approved but never "asked"
--
-- Every confirmed card that the floor manager informed the client about but
-- never pressed the second button for. With that button gone they would have no
-- route to the store manager at all — this is the one-time repair, and the
-- rewritten function above means it cannot recur.
-- ---------------------------------------------------------------------------
update public.job_cards
   set material_requested_at = coalesce(vendor_informed_at, confirmed_at, now())
 where status = 'confirmed'
   and vendor_informed_at is not null
   and material_requested_at is null;
