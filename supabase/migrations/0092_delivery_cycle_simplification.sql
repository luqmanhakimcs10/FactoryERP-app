-- =============================================================================
-- Factory ERP — the simplified delivery cycle, and four changes around it.
--
-- READ 0084's HEADER FIRST. This file reshapes the per-stage loop that 0056
-- built, 0062 tuned and 0084 last rewrote. The status names, the SLA reuse and
-- the "one status, two labels" rule all still hold. What changes is HOW MANY
-- STOPS there are on a round trip, and who is standing at each one.
--
-- THE CYCLE BEFORE THIS FILE — eight stops
-- ----------------------------------------
--   in_progress            floor work on stage 1
--   stage_qa               -> (QA) Pass QA
--   handover_for_delivery  -> (FM) Handover to <next stage>
--   awaiting_dp_collection -> (DP, Collection tab) Collect from FM   + photo
--   handed_over            -> (DP, Delivery tab)   Handover          + photo
--   handed_off             out at the partner
--   returned_to_delivery   -> (DP, Pickup tab)     Hand back
--   awaiting_fm_collection -> (FM) Collect  => advances the stage, opens stage_qa
--
-- THE CYCLE AFTER IT — four
-- -------------------------
--   in_progress            stage 1 only. In-house, on the machine. NO DELIVERY
--                          PERSON: the first time this role is involved at all
--                          is the handover that FOLLOWS embroidery.
--   stage_qa               -> (Inspector) Pass QA  + photo
--        |
--        +-- next stage exists -> handover_for_delivery
--        +-- no next stage     -> awaiting_final_qa
--
--   handover_for_delivery  -> (FM) "Handover to <next stage>", naming the
--                             delivery person AND the finishing partner
--                             => handed_over  DIRECTLY
--   handed_over            -> (DP, DELIVERY tab) deliver to the partner + photo
--   handed_off             "In Pickup" — at the partner, nothing for the DP to
--                          do. THE PARTNER PRESSES NOTHING to release it.
--   returned_to_delivery   -> (DP, DELIVERY tab) deliver to the Inspector
--                             + photo => advances the stage, opens stage_qa
--                             ("Completion", from the delivery person's side)
--
-- TWO STOPS ARE GONE, AND THEY ARE THE SAME STOP TWICE
-- ----------------------------------------------------
-- `awaiting_dp_collection` and `awaiting_fm_collection` both recorded a handover
-- INSIDE the building as a state of its own: the piece sat still while two
-- people standing next to each other each pressed a button about it. The
-- physical event is one event either way, so it is now recorded once, by the
-- person who actually carries the piece:
--
--   * The Floor Manager's handover IS the delivery person's collection. One
--     press, and the piece lands in the Delivery tab ready to go out.
--   * The delivery person's drop-off at the Inspector IS the stage advancing.
--     There is no "with manager" wait in between and no separate label for one:
--     QA passing is what surfaces the piece back to the Floor Manager for the
--     next handover, which it already did.
--
-- SO THE DELIVERY PERSON HAS EXACTLY TWO ACTION TABS
-- --------------------------------------------------
--   Delivery   handed_over          -> deliver to the finishing partner
--              returned_to_delivery -> deliver to the Inspector
--   Pickup     handed_off           -> collect back from the finishing partner
--
-- Both Delivery rows are the same physical act — drop something off, with a
-- photo — and differ only in where. `destination_kind` on the queue says which,
-- so the button can name its destination without the client deciding for itself
-- which transition a status is allowed.
--
-- A fourth value, `completion`, is returned for pieces this delivery person has
-- already dropped at the Inspector and which are still there. It is a STATUS,
-- not a tab: nothing on those rows is pressable. It exists so the last leg of
-- the job is visible to the person who did it instead of vanishing.
--
-- THE PARTNER PRESSES NOTHING
-- ---------------------------
-- 0062 made `partner_ready_for_collection` a signal rather than a gate. It is
-- now not even a signal — both partner views are read-only, and the Pickup tab
-- lists every piece that is out, with how long it has been out and its SLA, so
-- the delivery person can judge. The RPCs are left in place (section 7): they
-- gate nothing, and dropping a callable nothing calls is a separate decision
-- from removing a button.
--
-- ONE RETURN-TYPE RULE, REPEATED FROM 0062 AND 0084
-- -------------------------------------------------
-- CREATE OR REPLACE refuses a changed return type or argument list, and
-- PostgREST resolves overloads by argument NAME. Every function whose shape
-- changes is dropped by its exact old signature first — leaving the old one
-- callable would let a stale client keep using a transition this file removes.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. The role is called Inspector.
--
-- The KEY stays `qa`. It is a foreign key from `profiles.role`, it appears in
-- 74 assert_role calls and in every RLS policy on the order spine, and renaming
-- it would be a data migration to change a word on a badge. `roles.name` is the
-- label, and the label is the thing being changed — 0086 set it to 'QA' for the
-- same reason, from the other direction.
--
-- "QA" as the name of the STEP is untouched on purpose: Stage QA, Pass QA and
-- Final QA are inspections, not people, and the brief renames the role.
-- ---------------------------------------------------------------------------
update public.roles set name = 'Inspector' where key = 'qa';


-- ---------------------------------------------------------------------------
-- 2. Tapping an order goes straight into Start QA.
--
-- The whole-cloth accept/flag gate is gone. It asked the Inspector to make a
-- judgement about a consignment BEFORE looking at a single piece in it, and all
-- it produced was permission to start doing the thing they had already come to
-- do. Accepting and flagging happen per piece now, in the pass/reject flow that
-- was always underneath it.
--
-- `awaiting_cloth_inspection` STAYS as an order status. It is what
-- `submit_order` and the procurement path both land on, it is what the Order
-- Taker's tracker and every banner already read, and it is the honest name for
-- "submitted, with the Inspector, not yet looked at". What changes is that the
-- Inspector no longer presses anything to leave it: the first piece decision
-- does it.
--
-- `qa_accept_cloth` and `qa_report_cloth_damage` are deliberately NOT dropped.
-- Neither is reachable from a screen any more, but the first is the only thing
-- that can advance an order nobody will inspect piecewise, and the second is
-- the only way to file a consignment-level finding against a vendor. Removing
-- the buttons and removing the capability are different decisions.
-- ---------------------------------------------------------------------------

/**
 * Open inspection on an order nobody has opened yet.
 *
 * Idempotent and silent: called at the top of the piece-level QA transitions,
 * so whichever of pass / reject the Inspector reaches for first is the one that
 * opens the order. `inspected_at` is stamped here because that is genuinely
 * when a human first looked at the consignment — the timeline and the status
 * board both read it, and both stay correct.
 */
create or replace function public.qa_open_inspection(p_order_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Guarded in its own right, not only by its callers. It is SECURITY DEFINER
  -- and granted to `authenticated`, so without this any signed-in user could
  -- advance an order past the inspection gate by calling it directly — the
  -- callers' assertions protect the callers, not this.
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  update public.orders
     set status = 'awaiting_coding',
         inspected_at = coalesce(inspected_at, now())
   where id = p_order_id
     -- Own factory only. The piece-level callers reach this through
     -- assert_my_order; a direct call has nothing else standing between it and
     -- another tenant's order.
     and factory_id = public.current_factory_id()
     and status = 'awaiting_cloth_inspection';
end $$;

grant execute on function public.qa_open_inspection(uuid) to authenticated;

-- Regenerated from 0059's bodies — the current definitions — with the status
-- guard widened and the open call added in front. Per this project's standing
-- rule the body is copied from the live version rather than retyped from an
-- older one; two regressions came from doing the opposite.

create or replace function public.qa_pass_piece(
  p_order_id  uuid,
  p_sheet_id  uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_order  public.orders;
  v_sheet  public.sheets;
  v_repeat public.repeats;
  c        record;
  v_next   int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  -- The gate that used to be a screen.
  if v_order.status = 'awaiting_cloth_inspection' then
    perform public.qa_open_inspection(p_order_id);
    select * into v_order from public.orders where id = p_order_id;
  end if;

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_photo_url is null or length(trim(p_photo_url)) = 0 then
    raise exception 'A photo is required to pass a piece.' using errcode = '22023';
  end if;

  select * into v_sheet from public.sheets
   where id = p_sheet_id and order_id = p_order_id;
  if not found then
    raise exception 'That sheet does not belong to this order.' using errcode = '22023';
  end if;

  select * into c from public.sheet_piece_counts(p_sheet_id);
  if c.coded + c.held >= v_sheet.repeats_count then
    raise exception 'Every piece on this sheet has already been inspected.' using errcode = '22023';
  end if;

  v_next := c.coded + 1;

  insert into public.repeats
    (factory_id, sheet_id, repeat_number, repeat_code, current_status)
  values
    (v_order.factory_id, p_sheet_id, v_next,
     v_order.order_code || '-S' || v_sheet.sheet_number || '-R' || lpad(v_next::text, 3, '0'),
     'coded')
  returning * into v_repeat;

  perform public.log_repeat_stage(
    v_repeat.id, 'coded', null, p_photo_url, 'Passed at initial QA'
  );

  return v_repeat;
end $$;

create or replace function public.qa_reject_piece(
  p_order_id    uuid,
  p_sheet_id    uuid,
  p_damage_type text,
  p_photo_url   text,
  p_note        text default null,
  p_scope       text default 'piece'
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order     public.orders;
  v_sheet     public.sheets;
  c           record;
  v_remaining int;
  v_count     int;
  i           int;
  v_id        uuid;
  v_ids       uuid[] := '{}';
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  -- Flagging a piece is how damaged cloth is reported now. It opens the order
  -- exactly as passing one does: an Inspector who finds the first piece torn
  -- should not have to accept the consignment before being allowed to say so.
  if v_order.status = 'awaiting_cloth_inspection' then
    perform public.qa_open_inspection(p_order_id);
    select * into v_order from public.orders where id = p_order_id;
  end if;

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_scope not in ('piece', 'sheet') then
    raise exception 'Invalid return scope.' using errcode = '22023';
  end if;

  select * into v_sheet from public.sheets
   where id = p_sheet_id and order_id = p_order_id;
  if not found then
    raise exception 'That sheet does not belong to this order.' using errcode = '22023';
  end if;

  select * into c from public.sheet_piece_counts(p_sheet_id);
  v_remaining := v_sheet.repeats_count - c.coded - c.held;

  if v_remaining <= 0 then
    raise exception 'Every piece on this sheet has already been inspected.' using errcode = '22023';
  end if;

  v_count := case when p_scope = 'sheet' then v_remaining else 1 end;

  for i in 1..v_count loop
    insert into public.damage_records
      (factory_id, order_id, sheet_id, repeat_id, stage_type, damage_type,
       responsible_type, responsible_id, photo_url, note, reported_by, recheck_state)
    values
      (v_order.factory_id, p_order_id, p_sheet_id, null, 'repeat_qa',
       p_damage_type, 'vendor', v_order.vendor_id, p_photo_url, p_note, auth.uid(),
       'awaiting_return')
    returning id into v_id;
    v_ids := array_append(v_ids, v_id);
  end loop;

  return jsonb_build_object('damage_ids', v_ids, 'count', v_count);
end $$;


-- ---------------------------------------------------------------------------
-- 3. The Floor Manager's handover IS the delivery person's collection.
--
-- Body is 0084's, with one line changed: the status logged is `handed_over`
-- rather than `awaiting_dp_collection`. Everything else — the delivery person
-- and partner validation, the partner/stage-type match, the destination stamped
-- onto the history row — is Fix 4's and stays exactly as it was.
--
-- `dp_collected_photo_url` is no longer written by anything. That column held
-- the proof of a transfer that no longer has its own step; the handover photo
-- the delivery person takes on the way OUT (dp_handover_to_partner) is the
-- first custody photo on this leg now. The column is left in place — it holds
-- real photographs of real transfers that did happen.
-- ---------------------------------------------------------------------------
create or replace function public.fm_hand_over_stage(
  p_repeat_id   uuid,
  p_delivery_id uuid,
  p_partner_id  uuid
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory    uuid := public.current_factory_id();
  v_repeat     public.repeats;
  st           public.order_stages;
  v_order_id   uuid;
  v_next       public.order_stages;
  v_partner    public.finishing_partners;
  v_hist       uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'handover_for_delivery' then
    raise exception 'This repeat is not ready for handover (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
     where id = p_delivery_id and factory_id = v_factory and role = 'delivery' and is_active
  ) then
    perform public.raise_not_found('Delivery person not found.');
  end if;

  select * into v_partner from public.finishing_partners
   where id = p_partner_id and factory_id = v_factory and deleted_at is null;
  if not found then
    perform public.raise_not_found('Finishing partner not found.');
  end if;

  st := public.repeat_current_stage(p_repeat_id);
  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  -- The stage the piece is going TO. qa_pass_stage_qa only produces
  -- handover_for_delivery when one exists, so its absence means the repeat was
  -- moved here by something that should not have.
  select * into v_next from public.order_stages
   where order_id = v_order_id and sequence = greatest(v_repeat.current_stage_index, 1) + 1;
  if not found then
    raise exception 'This repeat has no next stage to hand over for.' using errcode = '22023';
  end if;

  if v_partner.stage_type is distinct from v_next.stage_type then
    raise exception '% does not handle %.', v_partner.name, replace(v_next.stage_type, '_', ' ')
      using errcode = '22023';
  end if;

  update public.repeats
     set current_delivery_id = p_delivery_id,
         current_partner_id  = p_partner_id,
         partner_ready_at    = null
   where id = p_repeat_id;

  -- THE CHANGE. Straight to `handed_over` — in the delivery person's hands,
  -- sitting in their Delivery tab, ready to go out. There is no intervening
  -- "awaiting collection" state because there is no second press.
  v_hist := public.log_repeat_stage(p_repeat_id, 'handed_over', st.id, null,
              'Handed to ' ||
              coalesce((select display_name from public.profiles where id = p_delivery_id), 'delivery') ||
              ' for ' || replace(v_next.stage_type, '_', ' ') || ' — ' || v_partner.name);

  -- Stamp the destination onto the history row so the journey summary can show
  -- where a piece was sent from the moment it was sent (0084, Fix 7).
  update public.repeat_stage_history set partner_id = p_partner_id where id = v_hist;

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- Nothing produces `awaiting_dp_collection` any more, so nothing can consume
-- it. Left callable, it would be a transition out of a state the app can no
-- longer enter — the exact shape of dead end this codebase keeps finding.
drop function if exists public.dp_collect_from_floor(uuid, text);


-- ---------------------------------------------------------------------------
-- 4. The delivery person's two tabs.
--
-- Three statuses, two tabs, plus a read-only completion view. `tab` is still
-- computed in SQL for 0084's reason: which tab a status belongs to is part of
-- the workflow definition, and a client that decides for itself can file a
-- piece under a tab whose action the database will then refuse.
--
-- `destination_kind` is new and does the same job one level down. Both Delivery
-- rows are "drop this off, with a photo"; only the destination differs, and the
-- destination is derived from the status rather than guessed from whether a
-- partner name happens to be set.
--
-- THE COMPLETION ROWS. A piece the delivery person has dropped at the Inspector
-- is `stage_qa` with `current_delivery_id` still set — the leg's record is kept
-- until QA passes it (section 5), which is what clears it. That is the only
-- reason those rows can be found here at all, and it is why stage 1's Stage QA
-- never appears: an in-house embroidery piece was never handed to anybody.
--
-- THE NULL CASE IS STILL DELIBERATE. Anything carrying no `current_delivery_id`
-- is visible to EVERY delivery person: an unassigned piece someone can still
-- move is a queue entry, an unassigned piece nobody can see is a lost parcel.
-- ---------------------------------------------------------------------------
drop function if exists public.dp_orders_queue();

create or replace function public.dp_orders_queue()
returns table (
  repeat_id           uuid,
  repeat_code         text,
  order_id            uuid,
  order_code          text,
  vendor_name         text,
  sheet_number        int,
  color_assignment    text,
  order_stage_id      uuid,
  stage_type          text,
  stage_sequence      int,
  total_stages        int,
  current_status      text,
  tab                 text,
  destination_kind    text,
  partner_id          uuid,
  partner_name        text,
  destination_stage   text,
  sla_hours           int,
  handed_off_at       timestamptz,
  sla_breached        boolean,
  arrived_at          timestamptz,
  partner_ready_at    timestamptz,
  current_delivery_id uuid
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  return query
  select
    r.id, r.repeat_code, o.id, o.order_code, coalesce(v.name, '—'),
    sh.sheet_number, sh.color_assignment,
    st.id, st.stage_type, st.sequence,
    (select count(*)::int from public.order_stages os where os.order_id = o.id),
    r.current_status,
    -- Casts are load-bearing, not decoration: the branches are untyped
    -- literals, so without them the CASE resolves to `unknown` and the whole
    -- function fails at run time with "structure of query does not match
    -- function result type".
    (case r.current_status
      when 'handed_over'          then 'delivery'
      when 'returned_to_delivery' then 'delivery'
      when 'handed_off'           then 'pickup'
      else                             'completion'
    end)::text,
    (case r.current_status
      when 'handed_over'          then 'partner'
      when 'returned_to_delivery' then 'qa'
      when 'handed_off'           then 'partner'
      else                             'qa'
    end)::text,
    r.current_partner_id, fp.name,
    -- The stage this trip is FOR.
    --
    -- On the way OUT (`handed_over`) that is the stage after the one just
    -- cleared — what the Floor Manager's button named. On the way BACK
    -- (`handed_off`, `returned_to_delivery`) it is the same stage: the work the
    -- partner is doing or has just done. `current_stage_index` does not advance
    -- until the piece reaches the Inspector, so both read from `nxt`.
    nxt.stage_type,
    st.sla_hours,
    lastleg.handed_off_at,
    coalesce(
      exists (select 1 from public.sla_alerts a
               where a.repeat_id = r.id and a.resolved_at is null),
      false),
    r.updated_at,
    r.partner_ready_at,
    r.current_delivery_id
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  left join public.vendors v on v.id = o.vendor_id
  left join public.order_stages st
         on st.order_id = o.id and st.sequence = greatest(r.current_stage_index, 1)
  left join public.order_stages nxt
         on nxt.order_id = o.id and nxt.sequence = greatest(r.current_stage_index, 1) + 1
  left join public.finishing_partners fp on fp.id = r.current_partner_id
  left join lateral (
    select h.handed_off_at
      from public.repeat_stage_history h
     where h.repeat_id = r.id and h.handed_off_at is not null and h.returned_at is null
     order by h.handed_off_at desc
     limit 1
  ) lastleg on true
  where r.factory_id = v_factory
    and (
      r.current_status in ('handed_over', 'handed_off', 'returned_to_delivery')
      -- Completion: dropped at the Inspector, still there. Scoped to a real
      -- courier so an in-house stage-1 Stage QA can never appear here.
      or (r.current_status = 'stage_qa' and r.current_delivery_id is not null)
    )
    -- Mine, or nobody's. company_admin oversees the whole floor and sees all.
    and (
      public.current_user_role() = 'company_admin'
      or r.current_delivery_id is null
      or r.current_delivery_id = auth.uid()
    )
  order by
    (exists (select 1 from public.sla_alerts a
              where a.repeat_id = r.id and a.resolved_at is null)) desc,
    r.updated_at desc,
    r.repeat_code;
end $$;

-- Dropped and recreated, so the grant goes with it.
grant execute on function public.dp_orders_queue() to authenticated;

-- `dp_handover_to_partner` (0084) and `dp_collect_from_partner` (0062) are
-- UNCHANGED and deliberately not restated here. Their transitions are exactly
-- the ones this cycle keeps — handed_over -> handed_off, and handed_off ->
-- returned_to_delivery — and both already require the photo. Re-emitting a
-- function to change nothing in it is how a body drifts from the version that
-- was working.

-- The delivery person hands the piece to the INSPECTOR now, not back to the
-- Floor Manager, and that drop-off is what advances the stage. The old call
-- would leave the piece at `awaiting_fm_collection`, a state whose only exit is
-- being dropped by this file.
drop function if exists public.dp_hand_back_to_floor(uuid);

/**
 * Deliver the piece to the Inspector. Photo required. Closes the delivery
 * person's leg — this is "Completion" on their side.
 *
 * This body is `fm_confirm_collection`'s (0084, Fix 6) moved to the person who
 * is actually holding the piece, plus the photo every other custody change in
 * this app leaves. The stage advance is the same advance, in the same place in
 * the chain: what changes is that a piece stops waiting on a Floor Manager to
 * confirm receipt of something they can see on the table.
 *
 * The courier and the partner are NOT cleared here. They are the record of the
 * leg that just finished, the completion view reads them back, and
 * `qa_pass_stage_qa` clears them when the piece moves on.
 */
create or replace function public.dp_deliver_to_qa(
  p_repeat_id uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat   public.repeats;
  v_order_id uuid;
  v_total    int;
  v_next     public.order_stages;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'returned_to_delivery' then
    raise exception 'This repeat has not been collected back from the partner yet (status: %).',
      v_repeat.current_status using errcode = '22023';
  end if;
  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the piece as delivered to the Inspector is required.'
      using errcode = '22023';
  end if;

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;
  select count(*) into v_total from public.order_stages where order_id = v_order_id;

  if v_repeat.current_stage_index < v_total then
    select * into v_next from public.order_stages
     where order_id = v_order_id and sequence = v_repeat.current_stage_index + 1;

    update public.repeats
       set current_stage_index = current_stage_index + 1
     where id = p_repeat_id;

    -- Straight to Stage QA: the partner's work is what is being inspected.
    perform public.log_repeat_stage(p_repeat_id, 'stage_qa', v_next.id, p_photo_url,
      'Delivered to the Inspector — ' || replace(v_next.stage_type, '_', ' ') ||
      ' work awaiting Stage QA');

    -- The piece is back in the building, so the order reads as in production.
    update public.orders
       set status = 'in_production', updated_at = now()
     where id = v_order_id and status = 'in_finishing';
  else
    -- Kept for the same reason 0084 kept it: a piece should never reach this
    -- branch, because qa_pass_stage_qa sends a cleared final stage straight to
    -- Final QA. It costs one comparison and it is the difference between a
    -- stranded repeat and a completed one if anything ever does.
    perform public.log_repeat_stage(p_repeat_id, 'awaiting_final_qa', null, p_photo_url,
      'All stages complete');
  end if;

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

grant execute on function public.dp_deliver_to_qa(uuid, text) to authenticated;

-- The Floor Manager's end of the retired round trip. `fm_confirm_collection`
-- was the only exit from `awaiting_fm_collection` and `fm_pending_collections`
-- was the only thing that listed it; with nothing able to enter that status,
-- both are a button and a prompt for work that cannot exist.
drop function if exists public.fm_confirm_collection(uuid);
drop function if exists public.fm_pending_collections(uuid);


-- ---------------------------------------------------------------------------
-- 5. Passing Stage QA closes the leg.
--
-- Body is 0084's Fix 3, with the courier/partner clear added. Those two columns
-- describe the trip the piece has just finished; once the Inspector passes it,
-- the piece either goes out again (and `fm_hand_over_stage` writes a fresh
-- pair) or it goes to Final QA. Leaving them set would keep a completed leg
-- showing in the delivery person's completion view forever.
--
-- The branch itself is unchanged, and it is what makes point 4 of the brief
-- true without adding anything: passing puts the piece at
-- `handover_for_delivery`, which IS the Floor Manager's "Handover to <next
-- stage>" button. There is no waiting state in between to give a label to.
-- ---------------------------------------------------------------------------
create or replace function public.qa_pass_stage_qa(
  p_repeat_id uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat   public.repeats;
  st         public.order_stages;
  v_order_id uuid;
  v_total    int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'stage_qa' then
    raise exception 'This repeat is not at Stage QA (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;
  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the piece is required to pass Stage QA.' using errcode = '22023';
  end if;

  st := public.repeat_current_stage(p_repeat_id);

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;
  select count(*) into v_total from public.order_stages where order_id = v_order_id;

  -- The delivery leg that brought this piece here is over.
  update public.repeats
     set current_partner_id  = null,
         current_delivery_id = null,
         partner_ready_at    = null
   where id = p_repeat_id;

  if greatest(v_repeat.current_stage_index, 1) < v_total then
    perform public.log_repeat_stage(p_repeat_id, 'handover_for_delivery', st.id, p_photo_url,
      'Stage QA passed — ready for handover');
  else
    -- Last stage. Nothing left to send it out for.
    perform public.log_repeat_stage(p_repeat_id, 'awaiting_final_qa', st.id, p_photo_url,
      'Stage QA passed on the final stage — sent to Final QA');
  end if;

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;


-- ---------------------------------------------------------------------------
-- 6. Draining the pieces already in flight.
--
-- Two statuses are being removed from the cycle while real pieces are sitting
-- in them. Neither can be left alone: with their only exit dropped they would
-- be stranded, which is this codebase's recurring failure and the reason this
-- section exists at all.
--
-- Both moves are the honest equivalent, not a fabrication:
--
--   awaiting_dp_collection  The Floor Manager has already released the piece
--                           and named the courier and the partner. Under the new
--                           cycle that IS `handed_over` — the same piece, the
--                           same hands, one less button.
--
--   awaiting_fm_collection  The delivery person has already handed the piece
--                           back; it is physically in the building. Under the
--                           new cycle the drop-off is what advances the stage,
--                           so these land where `dp_deliver_to_qa` would have
--                           put them: stage index +1, at Stage QA.
--
-- Written as plain DML rather than through `log_repeat_stage`, deliberately.
-- That function reads `current_factory_id()` and `auth.uid()`, and this file is
-- run from the SQL editor with neither — calling it here would fail on every
-- row. The history rows below are therefore written directly, with a null actor
-- and a note that says what moved them, which is the truth: no person did.
-- ---------------------------------------------------------------------------
do $$
declare
  r        record;
  v_next   public.order_stages;
  n_coll   int := 0;
  n_fm     int := 0;
begin
  -- awaiting_dp_collection -> handed_over
  for r in
    select rp.id, rp.factory_id, rp.current_stage_index, s.order_id
      from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where rp.current_status = 'awaiting_dp_collection'
  loop
    insert into public.repeat_stage_history
      (factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note)
    values
      (r.factory_id, r.id,
       (select os.id from public.order_stages os
         where os.order_id = r.order_id
           and os.sequence = greatest(r.current_stage_index, 1)),
       'handed_over', null, null,
       'Migrated by 0092 — the Floor Manager handover is now the collection');

    update public.repeats
       set current_status = 'handed_over', updated_at = now()
     where id = r.id;

    n_coll := n_coll + 1;
  end loop;

  -- awaiting_fm_collection -> stage index +1, at stage_qa
  for r in
    select rp.id, rp.factory_id, rp.current_stage_index, s.order_id,
           (select count(*)::int from public.order_stages os where os.order_id = s.order_id) as total
      from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where rp.current_status = 'awaiting_fm_collection'
  loop
    if r.current_stage_index < r.total then
      select * into v_next from public.order_stages
       where order_id = r.order_id and sequence = r.current_stage_index + 1;

      insert into public.repeat_stage_history
        (factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note)
      values
        (r.factory_id, r.id, v_next.id, 'stage_qa', null, null,
         'Migrated by 0092 — delivered to the Inspector; ' ||
         replace(v_next.stage_type, '_', ' ') || ' work awaiting Stage QA');

      update public.repeats
         set current_status = 'stage_qa',
             current_stage_index = current_stage_index + 1,
             updated_at = now()
       where id = r.id;

      update public.orders
         set status = 'in_production', updated_at = now()
       where id = r.order_id and status = 'in_finishing';
    else
      insert into public.repeat_stage_history
        (factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note)
      values
        (r.factory_id, r.id, null, 'awaiting_final_qa', null, null,
         'Migrated by 0092 — all stages complete');

      update public.repeats
         set current_status = 'awaiting_final_qa', updated_at = now()
       where id = r.id;
    end if;

    n_fm := n_fm + 1;
  end loop;

  raise notice '0092: moved % piece(s) from awaiting_dp_collection to handed_over', n_coll;
  raise notice '0092: moved % piece(s) from awaiting_fm_collection into Stage QA', n_fm;
end $$;


-- ---------------------------------------------------------------------------
-- 7. The status board loses "With Manager after X".
--
-- Point 4 of the brief: QA passing is what surfaces a piece back to the Floor
-- Manager, so there is nothing for a separate waiting label to describe. A
-- piece at `handover_for_delivery` reads as what it is about to be — queued for
-- the trip to the next stage — which is the same row `handed_over` already
-- lands on and the same one the Floor Manager's own "Handover to <stage>"
-- button sits in.
--
-- `awaiting_dp_collection` and `awaiting_fm_collection` keep their mappings.
-- Section 6 has drained every live row, but this function is IMMUTABLE and
-- argument-only, so it is also the natural thing to point at a history row; a
-- key that returns 'other' for a status this app used for two months would make
-- old evidence unreadable.
-- ---------------------------------------------------------------------------
create or replace function public.repeat_status_key(
  p_status      text,
  p_stage_index int
)
returns text
language sql immutable set search_path = public as $$
  select case p_status
    when 'ready_for_production'   then 'pre:'      || greatest(coalesce(p_stage_index, 1), 1)
    when 'in_progress'            then 'in:'       || greatest(coalesce(p_stage_index, 1), 1)
    when 'stage_qa'               then 'qa:'       || greatest(coalesce(p_stage_index, 1), 1)
    -- THE CHANGE. Was 'mgr:S'; now the same key `handed_over` carries, because
    -- from the floor's side both mean "cleared, queued for the next stage".
    when 'handover_for_delivery'  then 'handover:' || (greatest(coalesce(p_stage_index, 1), 1) + 1)
    when 'awaiting_dp_collection' then 'handover:' || (greatest(coalesce(p_stage_index, 1), 1) + 1)
    when 'handed_over'            then 'handover:' || (greatest(coalesce(p_stage_index, 1), 1) + 1)
    when 'handed_off'             then 'in:'       || (greatest(coalesce(p_stage_index, 1), 1) + 1)
    when 'returned_to_delivery'   then 'pickup:'   || (greatest(coalesce(p_stage_index, 1), 1) + 1)
    when 'awaiting_fm_collection' then 'pickup:'   || (greatest(coalesce(p_stage_index, 1), 1) + 1)
    when 'awaiting_final_qa'      then 'final'
    when 'awaiting_qa_final'      then 'final'
    when 'completed'              then 'done'
    when 'damaged'                then 'damaged'
    when 'coded'                  then 'precoded'
    when 'awaiting_job_card'      then 'precoded'
    else 'other'
  end
$$;

comment on function public.repeat_status_key(text, int) is
  'Granular status key for a repeat. Derived only — see 0090, amended by 0092 '
  '(handover_for_delivery folds into the handover row; there is no "with '
  'manager" state of its own).';

-- The last stage's `handover_for_delivery` cannot happen — qa_pass_stage_qa
-- sends a cleared final stage to Final QA — so folding it into `handover:S+1`
-- cannot produce a key with no row to land on.


-- ---------------------------------------------------------------------------
-- 8. The order status board, without the "With Manager" slot.
--
-- Body is 0090's, with `mgr` removed from the per-stage slot list, the guard
-- that suppressed it on the last stage removed with it, and the photo lateral's
-- `else` branch — which existed only to serve `mgr` — dropped.
--
-- Every other line, including the comment explaining why the transit states
-- resolve against the PREVIOUS stage, is unchanged: that arithmetic is what
-- makes the board correct, and it has not moved.
-- ---------------------------------------------------------------------------
create or replace function public.fm_order_status_board(p_order_id uuid)
returns table (
  step_key  text,
  label     text,
  kind      text,
  state     text,
  count     int,
  at        timestamptz,
  photo_url text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_order   public.orders;
  v_card    public.job_cards;
  v_issue   public.material_issues;
  v_total   int;
  v_repeats int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);

  select * into v_order from public.orders o
   where o.id = p_order_id and o.factory_id = v_factory;
  if not found then perform public.raise_not_found('Order not found.'); end if;

  select * into v_card from public.job_cards where order_id = p_order_id;
  select * into v_issue from public.material_issues
   where order_id = p_order_id order by created_at desc limit 1;

  select count(*) into v_total from public.order_stages where order_id = p_order_id;
  select count(*) into v_repeats
    from public.repeats r join public.sheets s on s.id = r.sheet_id
   where s.order_id = p_order_id;

  -- ---- the six milestones ----
  return query select
    'order_creation', 'Order Creation', 'milestone',
    case when v_order.submitted_at is not null then 'done' else 'current' end,
    null::int,
    coalesce(v_order.submitted_at, v_order.created_at),
    (select ph from unnest(coalesce(v_order.cloth_photos, '{}')) ph limit 1);

  return query select
    'order_inspection', 'Order Inspection', 'milestone',
    case
      when v_order.inspected_at is not null then 'done'
      when v_order.status = 'awaiting_cloth_inspection' then 'current'
      else 'ahead'
    end,
    null::int,
    v_order.inspected_at,
    coalesce(
      (select d.photo_url from public.damage_records d
        where d.order_id = p_order_id and d.stage_type = 'incoming_inspection'
          and d.photo_url is not null
        order by d.created_at desc limit 1),
      (select ph from unnest(coalesce(v_order.cloth_photos, '{}')) ph limit 1));

  return query select
    'job_card_creation', 'Job Card Creation', 'milestone',
    case
      when v_card.id is not null then 'done'
      when v_order.status = 'awaiting_job_card' then 'current'
      else 'ahead'
    end,
    null::int, v_card.created_at, v_order.design_sheet_url;

  return query select
    'job_card_approved', 'Job Card Approved', 'milestone',
    case
      when v_card.confirmed_at is not null then 'done'
      when v_card.id is not null then 'current'
      else 'ahead'
    end,
    null::int, v_card.confirmed_at, null::text;

  return query select
    'materials', 'Raw Materials Collection', 'milestone',
    case
      when v_issue.accepted_at is not null then 'done'
      when v_issue.id is not null then 'current'
      when v_card.material_requested_at is not null then 'current'
      else 'ahead'
    end,
    null::int, v_issue.accepted_at, v_issue.accepted_photo_url;

  return query select
    'machine', 'Machine Assignment', 'milestone',
    case
      when v_order.assigned_machine_id is not null then 'done'
      when v_order.status = 'machine_selection_pending' then 'current'
      else 'ahead'
    end,
    null::int,
    (select min(h.created_at) from public.repeat_stage_history h
       join public.repeats rp on rp.id = h.repeat_id
       join public.sheets s on s.id = rp.sheet_id
      where s.order_id = p_order_id and h.status = 'in_progress'),
    null::text;

  -- ---- one block of rows per configured stage ----
  return query
  with counts as (
    select case
             when k = 'done' and v_order.delivered_at is not null then 'delivered'
             when k = 'done' then 'ready'
             else k
           end as key2,
           count(*)::int as n
      from (
        select public.repeat_status_key(r.current_status, r.current_stage_index) as k
          from public.repeats r
          join public.sheets s on s.id = r.sheet_id
         where s.order_id = p_order_id
      ) z
     group by 1
  ),
  rows as (
    -- Stage 1 is worked in-house, so it has no handover/pickup rows in FRONT of
    -- it — the piece is already on the floor, and the delivery person has no
    -- part in embroidery at all.
    --
    -- 'mgr' was the fifth slot. It is gone: a piece that has cleared a stage
    -- reads as queued for the next one rather than as parked with a manager.
    select os.sequence, os.stage_type, os.id as stage_id, g.slot, g.ord
      from public.order_stages os
      cross join lateral (
        values
          ('handover', 1), ('in', 2), ('pickup', 3), ('qa', 4)
      ) as g(slot, ord)
     where os.order_id = p_order_id
       and not (os.sequence = 1 and g.slot in ('handover', 'pickup'))
  )
  select
    rw.slot || ':' || rw.sequence,
    case rw.slot
      when 'handover' then 'Handover to ' || public.stage_display_name(rw.stage_type) || ' - In Delivery'
      when 'in'       then 'In ' || public.stage_display_name(rw.stage_type)
      when 'pickup'   then 'In Pickup after ' || public.stage_display_name(rw.stage_type)
      else                 'Repeat Inspection after ' || public.stage_display_name(rw.stage_type)
    end,
    'stage',
    case when coalesce(c.n, 0) > 0 then 'current' else 'ahead' end,
    coalesce(c.n, 0),
    -- When the newest evidence at this stage was captured, and what it was.
    ph.at, ph.photo_url
  from rows rw
  left join counts c on c.key2 = rw.slot || ':' || rw.sequence
  left join lateral (
    /*
     * The newest photo for this exact sub-state.
     *
     * The history row for a TRANSIT state (handover / partner work / pickup)
     * carries the stage the piece had just cleared, which is one BEFORE the
     * stage those states are named after. `qa` carries its own stage. Getting
     * this backwards would put the clipping handover photo under embroidery.
     *
     * `handover_for_delivery` joins the handover branch for the same reason its
     * key does: it is the moment the floor released the piece for that trip.
     */
    select h.photo_url, h.created_at as at
      from public.repeat_stage_history h
      join public.repeats rp on rp.id = h.repeat_id
      join public.sheets s on s.id = rp.sheet_id
      join public.order_stages hs on hs.id = h.order_stage_id
     where s.order_id = p_order_id
       and h.photo_url is not null
       and case rw.slot
             when 'handover' then h.status in ('handover_for_delivery','awaiting_dp_collection','handed_over')
                                   and hs.sequence = rw.sequence - 1
             when 'pickup'   then h.status in ('returned_to_delivery','awaiting_fm_collection')
                                   and hs.sequence = rw.sequence - 1
             when 'in'       then (h.status = 'handed_off' and hs.sequence = rw.sequence - 1)
                                   or (h.status = 'in_progress' and hs.sequence = rw.sequence)
             else                 h.status = 'stage_qa' and hs.sequence = rw.sequence
           end
     order by h.created_at desc
     limit 1
  ) ph on true
  order by rw.sequence, rw.ord;

  -- ---- the tail ----
  return query
  with counts as (
    select case
             when k = 'done' and v_order.delivered_at is not null then 'delivered'
             when k = 'done' then 'ready'
             else k
           end as key2,
           count(*)::int as n
      from (
        select public.repeat_status_key(r.current_status, r.current_stage_index) as k
          from public.repeats r
          join public.sheets s on s.id = r.sheet_id
         where s.order_id = p_order_id
      ) z
     group by 1
  )
  select v.key, v.label, 'stage'::text,
         case when coalesce(c.n, 0) > 0 then 'current' else 'ahead' end,
         coalesce(c.n, 0),
         null::timestamptz,
         (select h.photo_url from public.repeat_stage_history h
            join public.repeats rp on rp.id = h.repeat_id
            join public.sheets s on s.id = rp.sheet_id
           where s.order_id = p_order_id
             and h.status = case v.key when 'final' then 'awaiting_final_qa' else 'completed' end
             and h.photo_url is not null
           order by h.created_at desc limit 1)
    from (values
      ('final',     'Floor Inspection by Manager'),
      ('ready',     'Ready'),
      ('delivered', 'Client Delivery')
    ) as v(key, label)
    left join counts c on c.key2 = v.key;

  return query select
    'completed', 'Completed', 'milestone',
    case
      when v_order.status = 'completed' then 'done'
      when v_order.delivered_at is not null then 'done'
      else 'ahead'
    end,
    v_repeats, v_order.delivered_at, v_order.delivery_photo_url;
end $$;

grant execute on function public.fm_order_status_board(uuid) to authenticated;

-- `fm_repeat_status_board` is NOT restated. Its label CASE still carries an
-- `mgr:%` branch, which `repeat_status_key` can no longer produce — a dead
-- branch in a 90-line function, against the risk of retyping the other 89
-- lines. The rule this project settled on after two regressions applies here
-- too, and it points at leaving it alone.


-- ---------------------------------------------------------------------------
-- 9. The banners follow the tabs.
--
-- Four delivery queues become two, one floor-manager queue goes, and the pickup
-- queue stops waiting for a signal nobody sends any more:
--
--   dp_collect   gone   — `awaiting_dp_collection` no longer exists
--   dp_send   \
--   dp_handback  }-> dp_deliver — one tab, one action, one banner
--   dp_pickup    widened — every piece out at a partner, not only flagged ones
--   fm_collect   gone   — `awaiting_fm_collection` no longer exists
--
-- Both functions are regenerated from 0089's bodies, which are the current
-- definitions, with only the blocks above changed. They are long and they touch
-- every role's dashboard; retyping the other three hundred lines to edit twenty
-- is how this project has previously reintroduced a bug it had already fixed.
-- ---------------------------------------------------------------------------
create or replace function public.my_queue_summary()
returns table (
  queue_key       text,
  label           text,
  count           int,
  banner_title    text,
  banner_subtitle text,
  own_task        boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_role    text   := public.current_user_role();

  v_roles   text[] := public.effective_roles();
  v_uid     uuid := auth.uid();
  v_partner uuid;
  n         int;
begin
  if v_factory is null or v_role is null then
    return;   -- super admin / unlinked user has no per-factory queue
  end if;

  if v_roles && array['floor_manager', 'company_admin'] then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared');
    if n > 0 then
      return query select 'awaiting_job_card', 'Orders awaiting a job card', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a job card',
        'Set the stage sequence so production can be planned',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.material_issues mi
     where mi.factory_id = v_factory and mi.accepted_at is null;
    if n > 0 then
      return query select 'accept_inventory', 'Material ready to accept', n,
        n || ' order' || case when n = 1 then '' else 's' end || ' ready to accept material',
        'Materials are waiting in the store — accept to start production',
        ('floor_manager' = any(v_roles));
    end if;

    -- `fm_collect` — "Pieces back from delivery" — was here. Nothing can reach
    -- `awaiting_fm_collection` any more (0092 section 4), so the banner would
    -- count to zero forever and its button no longer exists.

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handover_for_delivery';
    if n > 0 then
      return query select 'fm_handover', 'Stages ready to hand over', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to hand over',
        'Passed stage QA — hand to the delivery person',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory
       and r.current_status in ('awaiting_final_qa','awaiting_qa_final');
    if n > 0 then
      return query select 'fm_final_qa', 'Awaiting your final QA', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' final QA',
        'The last check before the piece is billed and delivered',
        ('floor_manager' = any(v_roles));
    end if;

    -- NEW — the dashboard's "Shift close" card already counts these. Same
    -- predicate as fm_shift_close_queue(), inlined behind module_enabled so a
    -- factory without machine_workforce gets no row instead of an exception.
    -- `managed_by is null` is in the original and is kept: an unassigned machine
    -- is everyone's to close, not nobody's.
    if public.module_enabled('machine_workforce') then
      select count(*) into n
        from public.shifts s
        join public.machines m on m.id = s.machine_id
       where s.factory_id = v_factory
         and s.status = 'open'
         and (('company_admin' = any(v_roles)) or m.managed_by = v_uid or m.managed_by is null);
      if n > 0 then
        return query select 'fm_shift_close', 'Shifts still open', n,
          n || ' shift' || case when n = 1 then '' else 's' end || ' still open',
          'Close each one to record stitches and pay the worker',
          ('floor_manager' = any(v_roles));
      end if;
    end if;

    -- NEW — the dashboard's "Leave" card already counts these.
    select count(*) into n from public.leaves l
     where l.factory_id = v_factory and l.status = 'pending';
    if n > 0 then
      return query select 'fm_leave', 'Leave requests', n,
        n || ' leave request' || case when n = 1 then '' else 's' end || ' to decide',
        'A worker is waiting on your approval',
        ('floor_manager' = any(v_roles));
    end if;

    -- Finished orders whose leftover material is still signed out to the floor.
    -- The Orders box grew a "Handover" tab for this and its count had no banner.
    select count(*) into n
      from public.orders o
     where o.factory_id = v_factory
       and o.status <> 'cancelled'
       and (o.status in ('ready_for_delivery','completed')
            or public.fm_floor_is_finished(o.id))
       and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
       and not exists (select 1 from public.fm_handovers h where h.order_id = o.id);
    if n > 0 then
      return query select 'fm_store_handover', 'Material to hand back', n,
        n || ' order' || case when n = 1 then '' else 's' end
          || case when n = 1 then ' needs' else ' need' end || ' material handed back',
        'Log what is left over so it goes back into store stock',
        ('floor_manager' = any(v_roles));
    end if;

    -- The automatic "stock was already here" notice. 0069 addresses it to the
    -- FLOOR MANAGER, and nothing was surfacing it to them.
    select count(*) into n
      from public.material_requests mr
     where mr.factory_id = v_factory
       and mr.origin = 'auto_stock_ready'
       and mr.directed_to = 'floor_manager'
       and mr.status = 'pending';
    if n > 0 then
      return query select 'fm_material_ready', 'Material ready in the store', n,
        n || ' order' || case when n = 1 then '' else 's' end
          || case when n = 1 then ' has' else ' have' end || ' material ready',
        'Everything these need is already in stock - collect it when you are ready',
        ('floor_manager' = any(v_roles));
    end if;
  end if;

  if v_roles && array['store_manager', 'company_admin'] then
    select count(*) into n from public.job_cards jc
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id);
    if n > 0 then
      return query select 'material_requests', 'Material requests', n,
        n || ' material request' || case when n = 1 then '' else 's' end || ' waiting',
        'The floor cannot start production until these are issued',
        ('store_manager' = any(v_roles));
    end if;

    select count(*) into n from public.grns g
     where g.factory_id = v_factory and g.status = 'pending';
    if n > 0 then
      return query select 'grn_pending', 'Deliveries to confirm', n,
        n || ' deliver' || case when n = 1 then 'y' else 'ies' end || case when n = 1 then ' needs' else ' need' end || ' checking in',
        'Confirm what actually arrived against the purchase order',
        ('store_manager' = any(v_roles));
    end if;

    -- A count of one outstanding obligation rather than of rows, so it is 1 or
    -- absent. The brief calls the daily audit mandatory; the Audit tab already
    -- flags it, and this puts the same flag where the role actually starts.
    if not exists (
      select 1 from public.stock_audits sa
       where sa.factory_id = v_factory and sa.audit_type = 'daily'
         and sa.audit_date = current_date
    ) then
      return query select 'sm_audit_today', 'Daily audit not done', 1,
        'Today''s stock audit has not been done',
        'Count every item once a day so the ledger stays trustworthy',
        ('store_manager' = any(v_roles));
    end if;

    -- NEW. The store manager owns the PO lifecycle from 0089: a PO sitting at
    -- Creation is waiting on them to go and buy it. This banner is what the
    -- three procurement PO banners became — the work did not disappear, it
    -- changed hands.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status in ('auto_generated','draft');
    if n > 0 then
      return query select 'sm_po_procure', 'Purchase orders to procure', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to procure',
        'Buy it from the supplier, then mark it Procured to send it to the accountant',
        ('store_manager' = any(v_roles));
    end if;
  end if;

  if v_roles && array['qa', 'company_admin'] then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_cloth_inspection','awaiting_coding');
    if n > 0 then
      return query select 'qa_inspection', 'Orders awaiting inspection', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' inspection',
        'Check the cloth, then code each piece',
        ('qa' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'stage_qa';
    if n > 0 then
      return query select 'qa_stage', 'Stage QA waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' stage QA',
        'Pass or mark damage before the stage can move on',
        ('qa' = any(v_roles));
    end if;
  end if;

  if v_roles && array['delivery', 'company_admin'] then
    -- Four delivery banners become two, matching the two tabs. `dp_collect`
    -- and `dp_handback` counted the two stops 0092 removed; `dp_send` and the
    -- return leg are one banner now because they are one tab and one action.
    select count(*) into n from public.repeats r
     where r.factory_id = v_factory
       and r.current_status in ('handed_over', 'returned_to_delivery')
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_deliver', 'Pieces to deliver', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' to drop off',
        'Out to the finishing partner, or back to the Inspector — photo required',
        ('delivery' = any(v_roles));
    end if;

    -- Every piece that is out, not only the ones a partner has flagged. The
    -- partner presses nothing now (0092), so waiting for a flag would be
    -- waiting forever.
    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_pickup', 'Pieces at a finishing partner', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' out at a partner',
        'Collect each one back when the partner has finished it',
        ('delivery' = any(v_roles));
    end if;

    -- NEW — the "Ready for final delivery" section on the delivery person's own
    -- Orders screen already lists these (9 in Alpha), and it is the last leg of
    -- the job: every stage is through QA and the order goes back to the client.
    -- Same predicate as dp_final_delivery_queue().
    if public.module_enabled('order_lifecycle') then
      select count(*) into n
        from public.orders o
       where o.factory_id = v_factory
         and o.status in ('ready_for_delivery','job_card_confirmed','in_production','in_finishing')
         and not exists (
           select 1 from public.repeats r
           join public.sheets s on s.id = r.sheet_id
           where s.order_id = o.id
             and r.current_status not in ('awaiting_final_qa','completed')
         );
      if n > 0 then
        return query select 'dp_final_delivery', 'Ready for final delivery', n,
          n || ' order' || case when n = 1 then '' else 's' end || ' ready for final delivery',
          'Every stage is through QA — these go back to the client',
          ('delivery' = any(v_roles));
      end if;
    end if;
  end if;

  if ('finishing_partner' = any(v_roles)) then
    select fp.id into v_partner from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;
    if v_partner is not null then
      select count(*) into n from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'handed_off'
         and r.current_partner_id = v_partner and r.partner_ready_at is null;
      if n > 0 then
        return query select 'partner_active', 'Work with you now', n,
          n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' your work',
          'Mark each one finished when you are done with it',
        true;
      end if;
    end if;
  end if;

  if v_roles && array['order_taker', 'company_admin'] then
    select count(*) into n
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (('company_admin' = any(v_roles)) or o.created_by = v_uid);
    if n > 0 then
      return query select 'ot_returns', 'Returns to complete', n,
        n || ' return' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' completing',
        'Photograph each piece as it goes back to the vendor',
        ('order_taker' = any(v_roles));
    end if;
  end if;

  if v_roles && array['accountant', 'company_admin'] then
    select count(*) into n from public.invoices i
     where i.factory_id = v_factory and i.status = 'pending';
    if n > 0 then
      return query select 'acct_receivables', 'Unpaid invoices', n,
        n || ' invoice' || case when n = 1 then '' else 's' end || ' unpaid',
        'Money owed to the factory — record payment when it arrives',
        ('accountant' = any(v_roles));
    end if;

    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'approved';
    if n > 0 then
      return query select 'acct_payables', 'Bills awaiting payment', n,
        n || ' bill' || case when n = 1 then '' else 's' end || ' waiting to be paid',
        'Approved and due — settle and record the payment',
        ('accountant' = any(v_roles));
    end if;
  end if;

  if ('company_admin' = any(v_roles)) then
    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'pending';
    if n > 0 then
      return query select 'owner_approvals', 'Approvals waiting on you', n,
        n || ' approval' || case when n = 1 then '' else 's' end || ' waiting on you',
        'Nothing moves on these until you decide',
        true;
    end if;
  end if;

  -- The three procurement PO banners (po_draft / po_bill / po_handover) were
  -- here. Procurement is read-only from 0089 — it has no PO transitions left to
  -- prompt, and a banner pointing at a button that no longer exists is worse
  -- than no banner. Their work moved to 'sm_po_procure' above and to the
  -- accountant's 'acct_payables'.
end $$;

create or replace function public.my_queue_items(p_queue_key text)
returns table (
  item_id      uuid,
  code         text,
  title        text,
  subtitle     text,
  order_id     uuid,
  order_code   text,
  secondary_id uuid,
  status       text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_role    text   := public.current_user_role();

  v_roles   text[] := public.effective_roles();
  v_uid     uuid := auth.uid();
  v_partner uuid;
begin
  if v_factory is null or v_role is null then
    return;
  end if;

  -- A queue key is not a capability. Asking for another role's queue returns
  -- NOTHING rather than raising, so a stale client requesting a key it no
  -- longer owns degrades to an empty list instead of an error screen.
  if p_queue_key in ('awaiting_job_card','accept_inventory','fm_handover',
                     'fm_final_qa','fm_shift_close','fm_leave')
     and not (v_roles && array['floor_manager','company_admin']) then return; end if;
  if p_queue_key in ('fm_store_handover','fm_material_ready')
     and not (v_roles && array['floor_manager','company_admin']) then return; end if;
  if p_queue_key in ('material_requests','grn_pending')
     and not (v_roles && array['store_manager','company_admin']) then return; end if;
  if p_queue_key in ('qa_inspection','qa_stage')
     and not (v_roles && array['qa','company_admin']) then return; end if;
  if p_queue_key in ('dp_deliver','dp_pickup','dp_final_delivery')
     and not (v_roles && array['delivery','company_admin']) then return; end if;
  if p_queue_key = 'partner_active' and not ('finishing_partner' = any(v_roles)) then return; end if;
  if p_queue_key = 'ot_returns' and not (v_roles && array['order_taker','company_admin']) then return; end if;
  if p_queue_key in ('acct_receivables','acct_payables')
     and not (v_roles && array['accountant','company_admin']) then return; end if;
  if p_queue_key = 'owner_approvals' and not ('company_admin' = any(v_roles)) then return; end if;
  if p_queue_key = 'sm_po_procure'
     and not (v_roles && array['store_manager','company_admin']) then return; end if;

  -- ---- Floor Manager -----------------------------------------------------
  if p_queue_key = 'awaiting_job_card' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(*)::text from public.sheets s where s.order_id = o.id) || ' sheet(s)',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared')
     order by o.created_at;

  elsif p_queue_key = 'accept_inventory' then
    return query
    select mi.id, o.order_code, o.order_code,
           'Issued by the store - ' || to_char(mi.created_at, 'DD Mon'),
           o.id, o.order_code, mi.id, 'pending'::text
      from public.material_issues mi
      join public.orders o on o.id = mi.order_id
     where mi.factory_id = v_factory and mi.accepted_at is null
     order by mi.created_at;

  elsif p_queue_key in ('fm_handover','fm_final_qa') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '), 'final'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory
       -- A CASE returning a STATUS cannot express the final-QA branch, which
       -- now matches two of them. Returning the BOOLEAN from each branch can.
       -- (The earlier shape would have yielded NULL for fm_final_qa, so the row
       --  test was never true and the queue came back empty.)
       and case p_queue_key
             when 'fm_handover' then r.current_status = 'handover_for_delivery'
             else r.current_status in ('awaiting_final_qa','awaiting_qa_final')
           end
     order by o.created_at, r.repeat_code;

  -- NEW. secondary_id is the shift, which is what ShiftClose opens on.
  elsif p_queue_key = 'fm_shift_close' then
    if not public.module_enabled('machine_workforce') then return; end if;
    return query
    select s.id, m.name, m.name,
           coalesce(wp.display_name, 'Unassigned') || ' - open since ' ||
             to_char(s.opened_at, 'DD Mon HH24:MI'),
           s.order_id, o.order_code, s.id, s.status
      from public.shifts s
      join public.machines m on m.id = s.machine_id
      left join public.profiles wp on wp.id = s.worker_id
      left join public.orders o on o.id = s.order_id
     where s.factory_id = v_factory
       and s.status = 'open'
       and (('company_admin' = any(v_roles)) or m.managed_by = v_uid or m.managed_by is null)
     order by m.name;

  -- NEW. Approve/reject is inline on the Leave box, so there is no per-item
  -- screen — the app routes the whole banner there rather than to a list that
  -- cannot be tapped through from.
  elsif p_queue_key = 'fm_leave' then
    return query
    select l.id, coalesce(wp.display_name, 'Worker'), coalesce(wp.display_name, 'Worker'),
           to_char(l.start_date, 'DD Mon') || ' to ' || to_char(l.end_date, 'DD Mon') ||
             ' - ' || l.reason,
           null::uuid, null::text, l.id, l.status
      from public.leaves l
      left join public.profiles wp on wp.id = l.worker_id
     where l.factory_id = v_factory and l.status = 'pending'
     order by l.requested_at;

  elsif p_queue_key = 'fm_store_handover' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(distinct mii.color_code)::text
                from public.material_issues mi2
                join public.material_issue_items mii on mii.material_issue_id = mi2.id
               where mi2.order_id = o.id) || ' item(s) issued',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status <> 'cancelled'
       and (o.status in ('ready_for_delivery','completed')
            or public.fm_floor_is_finished(o.id))
       and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
       and not exists (select 1 from public.fm_handovers h where h.order_id = o.id)
     order by o.updated_at desc;

  elsif p_queue_key = 'fm_material_ready' then
    return query
    select mr.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ready since ' || to_char(mr.requested_at, 'DD Mon'),
           o.id, o.order_code, mr.id, mr.status
      from public.material_requests mr
      join public.orders o on o.id = mr.order_id
      left join public.vendors v on v.id = o.vendor_id
     where mr.factory_id = v_factory
       and mr.origin = 'auto_stock_ready'
       and mr.directed_to = 'floor_manager'
       and mr.status = 'pending'
     order by mr.requested_at;

  -- ---- Store Manager -----------------------------------------------------
  elsif p_queue_key = 'material_requests' then
    return query
    select jc.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - confirmed ' || to_char(jc.confirmed_at, 'DD Mon'),
           o.id, o.order_code, jc.id, jc.status
      from public.job_cards jc
      join public.orders o on o.id = jc.order_id
      left join public.vendors v on v.id = o.vendor_id
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id)
     order by jc.confirmed_at;

  elsif p_queue_key = 'grn_pending' then
    return query
    select g.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier') || ' - raised ' || to_char(po.created_at,'DD Mon'),
           po.order_id, null::text, g.id, g.status
      from public.grns g
      join public.purchase_orders po on po.id = g.purchase_order_id
      left join public.suppliers s on s.id = po.supplier_id
     where g.factory_id = v_factory and g.status = 'pending'
     order by g.created_at;

  -- ---- QA ----------------------------------------------------------------
  elsif p_queue_key = 'qa_inspection' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             case when o.status = 'awaiting_cloth_inspection'
                  then 'check the cloth' else 'code the pieces' end,
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status in ('awaiting_cloth_inspection','awaiting_coding')
     order by o.created_at;

  elsif p_queue_key = 'qa_stage' then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '), 'stage QA'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory
       and r.current_status = 'stage_qa'
     order by o.created_at, r.repeat_code;

  -- ---- Delivery ----------------------------------------------------------
  elsif p_queue_key in ('dp_deliver','dp_pickup') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '),'stage')
             || coalesce(' - ' || fp.name, ''),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
      left join public.finishing_partners fp on fp.id = r.current_partner_id
     where r.factory_id = v_factory
       and public.dp_sees_repeat(r.current_delivery_id)
       and case p_queue_key
             when 'dp_pickup' then r.current_status = 'handed_off'
             -- The Delivery tab is one queue with two destinations: out to the
             -- partner, and back to the Inspector. Both are the same act.
             else r.current_status in ('handed_over','returned_to_delivery') end
     order by r.updated_at desc;

  -- NEW. Whole orders, not repeats — the final leg is delivered per order.
  elsif p_queue_key = 'dp_final_delivery' then
    if not public.module_enabled('order_lifecycle') then return; end if;
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(*)::text from public.repeats r
               join public.sheets s on s.id = r.sheet_id
              where s.order_id = o.id) || ' piece(s), all through QA',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status in ('ready_for_delivery','job_card_confirmed','in_production','in_finishing')
       and not exists (
         select 1 from public.repeats r
         join public.sheets s on s.id = r.sheet_id
         where s.order_id = o.id
           and r.current_status not in ('awaiting_final_qa','completed')
       )
     order by o.created_at;

  -- ---- Finishing Partner -------------------------------------------------
  elsif p_queue_key = 'partner_active' then
    select fp.id into v_partner from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;
    if v_partner is null then return; end if;
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '),'stage'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and r.current_partner_id = v_partner and r.partner_ready_at is null
     order by r.updated_at desc;

  -- ---- Order Taker -------------------------------------------------------
  elsif p_queue_key = 'ot_returns' then
    return query
    select d.id, o.order_code, o.order_code,
           'Rejected at QA - ' || replace(d.damage_type,'_',' '),
           o.id, o.order_code, d.id, coalesce(d.recheck_state,'awaiting_return')
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (('company_admin' = any(v_roles)) or o.created_by = v_uid)
     order by d.created_at;

  -- ---- Accountant / Owner ------------------------------------------------
  elsif p_queue_key = 'acct_receivables' then
    return query
    select i.id, i.invoice_code, i.invoice_code,
           coalesce(v.name, '-') || ' - ' || to_char(i.amount, 'FM999,999,990.00'),
           i.order_id, o.order_code, i.id, i.status
      from public.invoices i
      left join public.orders o on o.id = i.order_id
      left join public.vendors v on v.id = o.vendor_id
     where i.factory_id = v_factory and i.status = 'pending'
     order by i.created_at;

  elsif p_queue_key in ('acct_payables','owner_approvals') then
    return query
    select e.id,
           initcap(replace(e.category,'_',' ')),
           initcap(replace(e.category,'_',' ')),
           coalesce(e.description,'No description') || ' - ' || to_char(e.amount,'FM999,999,990.00'),
           null::uuid, null::text, e.id, e.status
      from public.expenses e
     where e.factory_id = v_factory
       and e.status = case p_queue_key when 'acct_payables' then 'approved' else 'pending' end
     order by e.created_at;

  -- ---- Procurement -------------------------------------------------------
  -- POs still at Creation, for the store manager who now owns them.
  elsif p_queue_key = 'sm_po_procure' then
    return query
    select po.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier assigned') || ' - ' ||
             (select count(*)::text from public.po_items pi where pi.purchase_order_id = po.id) || ' line(s)',
           po.order_id, null::text, po.id, po.status
      from public.purchase_orders po
      left join public.suppliers s on s.id = po.supplier_id
     where po.factory_id = v_factory
       and po.status in ('auto_generated','draft')
     order by po.created_at desc;
  end if;
end $$;

grant execute on function public.my_queue_summary() to authenticated;
grant execute on function public.my_queue_items(text) to authenticated;
