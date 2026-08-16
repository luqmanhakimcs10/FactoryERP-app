-- =============================================================================
-- Factory ERP — seven workflow changes to the production/finishing loop.
--
-- This file reshapes the per-stage cycle that 0056 built and 0062 tuned. Read
-- 0056's header first: the status names, the SLA reuse and the "one status, two
-- labels" rule all still hold. What changes here is WHO decides what, WHERE the
-- photos are required, and WHERE the QA checkpoint sits on the return leg.
--
-- THE CYCLE AFTER THIS FILE
-- -------------------------
--   Stage 1 is the in-house stage. Every stage after it is done by a finishing
--   partner, reached and returned through the delivery person. So:
--
--     in_progress             stage 1 on the floor            -> (FM) Go to QA
--     stage_qa                QA passes, PHOTO REQUIRED       -> (QA) Pass QA
--        |
--        +-- next stage exists -> handover_for_delivery
--        +-- no next stage     -> awaiting_final_qa           [FIX 3 + 4]
--
--     handover_for_delivery   -> (FM) "Handover to <next stage>", picking a
--                                delivery person AND a finishing partner in one
--                                popup                        [FIX 4]
--     awaiting_dp_collection  -> (DP, Collection tab) Collect  + photo
--     handed_over             -> (DP, Delivery tab) Handover   + photo  [FIX 5]
--     handed_off              out at the partner. SLA runs.
--     returned_to_delivery    -> (DP, Pickup tab) Hand back
--     awaiting_fm_collection  -> (FM) Collect
--        |
--        +-- advances to the next stage and lands on stage_qa  [FIX 6]
--
--   So a piece is QA'd once for the work the floor did, and once for the work
--   each partner did. Before this file the return leg re-opened the next stage
--   at `in_progress` with no checkpoint at all, which meant a partner's work
--   was never inspected — the one gap the per-stage QA pattern was supposed to
--   close.
--
-- WHAT THIS FILE DOES *NOT* TOUCH
-- -------------------------------
-- The Shift Close / payroll system (0016-0018, 0042). Machine assignment no
-- longer OPENS a shift, but shifts, per-stitch payroll and the Shift Calendar
-- keep working exactly as they do today, as their own independent flow. The
-- only casualty is `fm_assign_machine_with_shift`, the combined call that
-- existed solely to fuse the two — see section 2.
--
-- ONE RETURN-TYPE RULE, REPEATED FROM 0062
-- ----------------------------------------
-- CREATE OR REPLACE refuses a changed return type or a changed argument list,
-- and PostgREST resolves overloads by argument NAME. Every function below whose
-- shape changes is therefore dropped by its exact old signature first — leaving
-- the old one callable would let a screen keep using a transition this file
-- deliberately removed.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- FIX 1 — Accept inventory is an itemised, checked-off receipt.
--
-- The Floor Manager used to press one blanket "Confirm accept" against a row
-- that said only "3 colours, 412 m". Nobody can check a physical delivery
-- against that, so nobody did: the button meant "the material arrived, probably".
--
-- Now the screen lists every line on the issue and the Floor Manager ticks each
-- one as it is physically counted in. ALL lines must be ticked — partial receipt
-- is deliberately NOT supported, because a half-accepted issue would need its
-- own status, its own shortfall record, and an answer to whether the order may
-- still advance to machine selection. That is a different feature, not a looser
-- version of this one.
--
-- The tick is recorded per line rather than inferred from the issue, so the
-- record says which lines a human actually confirmed and when.
-- ---------------------------------------------------------------------------
alter table public.material_issue_items
  add column if not exists received_at timestamptz,
  add column if not exists received_by uuid references public.profiles(id) on delete set null;

/**
 * The lines behind one material issue — what the Floor Manager is ticking off.
 *
 * `material_issue_items` is keyed by colour and carries metres, because
 * `order_thread_requirements` (0008, recalculated per-needle in 0082) is the
 * only thing that writes it. The join to `inventory_items` is what turns a bare
 * colour code into "thread · red · 137.50 m" — the type and unit live there
 * since 0068, and this reads them rather than restating them, so a line here can
 * never disagree with the stock item it is drawn from.
 */
create or replace function public.fm_material_issue_lines(p_material_issue_id uuid)
returns table (
  item_id         uuid,
  color_code      text,
  item_type       text,
  unit            text,
  required_meters numeric,
  issued_meters   numeric,
  received_at     timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  if not exists (
    select 1 from public.material_issues mi
     where mi.id = p_material_issue_id and mi.factory_id = v_factory
  ) then
    perform public.raise_not_found('Material issue not found.');
  end if;

  return query
  select mii.id,
         mii.color_code,
         coalesce(ii.item_type, 'thread'),
         coalesce(ii.unit, 'm'),
         mii.required_meters,
         mii.issued_meters,
         mii.received_at
    from public.material_issue_items mii
    left join public.inventory_items ii
           on ii.factory_id = mii.factory_id
          and ii.color_code = mii.color_code
          and ii.item_type = 'thread'
   where mii.material_issue_id = p_material_issue_id
     and mii.factory_id = v_factory
   order by mii.color_code;
end $$;

-- The blanket two-argument accept is gone. A client still holding it would be
-- able to accept an issue without confirming a single line, which is the exact
-- behaviour this fix exists to remove.
drop function if exists public.fm_accept_inventory(uuid, text);

/**
 * Accept a material issue, line by line.
 *
 * Body is 0077's — which is 0041's status advance plus 0071's request closure,
 * and NOT 0040's, for the reason 0077's header spells out at length — with the
 * per-line receipt added in front of it.
 */
create or replace function public.fm_accept_inventory(
  p_material_issue_id uuid,
  p_photo_url         text,
  p_received_item_ids uuid[]
)
returns public.material_issues
language plpgsql security definer set search_path = public as $$
declare
  v_issue   public.material_issues;
  v_factory uuid := public.current_factory_id();
  v_total   int;
  v_ticked  int;
  v_alien   int;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the received materials is required.' using errcode = '22023';
  end if;

  select * into v_issue from public.material_issues where id = p_material_issue_id;
  if not found or v_issue.factory_id is distinct from v_factory then
    perform public.raise_not_found('Material issue not found.');
  end if;
  if v_issue.accepted_at is not null then
    raise exception 'This material issue has already been accepted.' using errcode = '22023';
  end if;

  select count(*) into v_total
    from public.material_issue_items
   where material_issue_id = p_material_issue_id;

  -- Ids that belong to some OTHER issue are refused rather than ignored. A
  -- caller passing them has lost track of which issue it is accepting, and
  -- silently dropping them would let that go unnoticed.
  select count(*) into v_alien
    from unnest(coalesce(p_received_item_ids, '{}'::uuid[])) x(id)
   where not exists (
     select 1 from public.material_issue_items mii
      where mii.id = x.id and mii.material_issue_id = p_material_issue_id
   );
  if v_alien > 0 then
    raise exception 'Received-item list does not match this material issue.' using errcode = '22023';
  end if;

  select count(*) into v_ticked
    from public.material_issue_items mii
   where mii.material_issue_id = p_material_issue_id
     and mii.id = any(coalesce(p_received_item_ids, '{}'::uuid[]));

  if v_total = 0 then
    raise exception 'This material issue has no lines to receive.' using errcode = '22023';
  end if;
  if v_ticked < v_total then
    raise exception 'Confirm every line as received — % of % ticked.', v_ticked, v_total
      using errcode = '22023';
  end if;

  update public.material_issue_items
     set received_at = now(), received_by = auth.uid()
   where material_issue_id = p_material_issue_id;

  update public.material_issues
     set accepted_by = auth.uid(), accepted_at = now(), accepted_photo_url = p_photo_url
   where id = p_material_issue_id
  returning * into v_issue;

  -- 0041's advance. Guarded on the source status so accepting a second issue on
  -- an order already in production cannot drag it backwards.
  update public.orders
     set status = 'machine_selection_pending'
   where id = v_issue.order_id
     and status = 'job_card_confirmed';

  -- 0071's addition: the request is finished once the floor has the material.
  update public.material_requests
     set status = 'completed', completed_at = now()
   where material_issue_id = p_material_issue_id and status <> 'completed';

  return v_issue;
end $$;


-- ---------------------------------------------------------------------------
-- FIX 2 — Assign a machine without opening a shift.
--
-- Assignment used to demand a worker, their photo and a shift start time before
-- it would record which machine an order runs on. Two unrelated facts were
-- fused: "this order runs on machine 3" (a production routing decision) and
-- "Asha is on machine 3 from 08:00" (a payroll record). Fusing them meant the
-- routing decision could not be made until someone was standing at the machine,
-- and Start Production was unreachable until a shift existed.
--
-- They are separated here. Assignment records the machine. The Shift Close /
-- payroll flow under Machine & Workforce is untouched and still opens shifts
-- through `fm_open_shift` — it is simply no longer in the way.
--
-- `fm_assign_machine_with_shift` (0057) is DROPPED rather than left callable. It
-- existed only to fuse the two steps into one screen; with the requirement gone
-- it is a second, divergent way to assign a machine, and 0056's header explains
-- what leaving those lying around does to a state machine.
-- ---------------------------------------------------------------------------
drop function if exists public.fm_assign_machine_with_shift(uuid, uuid, uuid, text, timestamptz, text, int);

/** 0076b's body, minus the open-shift requirement. Mount sync is unchanged. */
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
  -- A machine the caller does not manage must 404, not 403: a 403 would confirm
  -- it exists.
  if public.current_user_role() = 'floor_manager'
     and v_machine.managed_by is distinct from auth.uid() then
    perform public.raise_not_found('Machine not found.');
  end if;

  update public.orders
     set assigned_machine_id = p_machine_id
   where id = p_order_id
  returning * into v_order;

  -- Mount whatever material is already signed out onto this machine. Idempotent
  -- and a no-op when nothing is issued yet (0076b).
  perform public.fm_sync_machine_mounts(p_order_id);

  return v_order;
end $$;

/**
 * 0061's Start Production, with ONE statement removed: the open-shift check.
 *
 * This is 0061's text, not 0056's and not 0044's. Both of 0061's guards — "no
 * coded repeats at all" and "no repeat in a startable state" — are load-bearing
 * (they are the whole subject of that migration), as are its two error messages
 * and its `repeats_total` return key. Retyping this function from an earlier
 * version would silently delete all of that; see 0077's header for the last
 * time that happened and what it cost.
 */
create or replace function public.fm_start_production(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order     public.orders;
  v_first     uuid;
  r           record;
  v_moved     int := 0;
  v_repeats   int;
  v_startable int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'machine_selection_pending' then
    raise exception 'This order is not awaiting production start (status: %).', v_order.status
      using errcode = '22023';
  end if;

  -- ---- 0061's Fix 0: there must be something to produce. ----
  select count(*) into v_repeats
    from public.repeats rp
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id;

  if v_repeats = 0 then
    raise exception
      'This order has no coded repeats, so there is nothing to produce. Initial QA has to pass at least one piece before production can start.'
      using errcode = '22023';
  end if;

  if v_order.assigned_machine_id is null then
    raise exception 'Assign a machine before starting production.' using errcode = '22023';
  end if;

  -- 0061's open-shift check stood HERE. Removed by this file: assignment no
  -- longer opens a shift, so requiring one would make Start Production
  -- unreachable for every order — the dead end Fix 2 exists to remove.

  if not exists (select 1 from public.order_stages where order_id = p_order_id) then
    raise exception 'This order has no stages configured on its job card.' using errcode = '22023';
  end if;

  -- Repeats that can actually enter the loop. Refusing here is what stops a
  -- repeat being stranded outside it forever (0061's header).
  select count(*) into v_startable
    from public.repeats rp
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id
     and rp.current_status in ('ready_for_production', 'awaiting_stage');

  if v_startable = 0 then
    raise exception
      'None of this order''s % repeat(s) are ready for production. Every one of them is already past that point or has been damaged — there is nothing to start.',
      v_repeats using errcode = '22023';
  end if;

  update public.orders set status = 'in_production' where id = p_order_id;

  select id into v_first from public.order_stages
   where order_id = p_order_id order by sequence limit 1;

  for r in
    select rp.id from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where s.order_id = p_order_id
       and rp.current_status in ('ready_for_production', 'awaiting_stage')
  loop
    -- Straight to in_progress: there is no "Start stage" step any more (0056).
    update public.repeats set current_stage_index = 1 where id = r.id;
    perform public.log_repeat_stage(r.id, 'in_progress', v_first, null, 'Production started');
    v_moved := v_moved + 1;
  end loop;

  return jsonb_build_object(
    'order_id', p_order_id, 'status', 'in_production',
    'repeats_advanced', v_moved, 'repeats_total', v_repeats
  );
end $$;


-- ---------------------------------------------------------------------------
-- FIX 3 + FIX 4 (database half) — Stage QA needs a photo, and the last stage
-- stops asking for a delivery round trip it has no destination for.
--
-- The photo requirement matches Initial QA and the final pass: every other
-- inspection in this app leaves an image of what was approved, and Stage QA was
-- the one that did not. It is enforced HERE, not only on the button, so the
-- record cannot be skipped by any caller.
--
-- The last-stage change: 0056 deliberately removed the last-stage special case
-- so that every stage left the floor the same way. That was right when the
-- handover was "send it out for the stage just finished". It is wrong now the
-- handover names the stage the piece is going TO (Fix 4) — on the final stage
-- there is nothing to go to, so the round trip would be a courier journey to
-- nowhere and back. The piece lands on awaiting_final_qa directly instead.
-- ---------------------------------------------------------------------------
drop function if exists public.qa_pass_stage_qa(uuid);

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
-- FIX 4 — the Floor Manager names the destination, the courier AND the handler.
--
-- Before this, the Floor Manager pressed a bare "Hand over" and the delivery
-- person decided, later and alone, which finishing partner the piece went to.
-- That put a routing decision — which partner does this order's clipping — in
-- the hands of whoever happened to pick the piece up, and gave the floor no way
-- to see where its own work had gone until after it arrived.
--
-- Both choices are made together, at the moment of handover, by the person who
-- owns the order. `current_delivery_id` joins `current_partner_id` on `repeats`
-- as the CURRENT leg's working state; both are cleared when the leg closes.
-- ---------------------------------------------------------------------------
alter table public.repeats
  add column if not exists current_delivery_id uuid references public.profiles(id) on delete set null;

create index if not exists idx_repeats_current_delivery
  on public.repeats(current_delivery_id)
  where current_delivery_id is not null;

/** The delivery people a Floor Manager can hand a stage to. */
create or replace function public.fm_delivery_people()
returns table (id uuid, display_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  return query
  select p.id, p.display_name
    from public.profiles p
   where p.factory_id = v_factory
     and p.role = 'delivery'
     and p.is_active
   order by p.display_name;
end $$;

-- Old signature refused: a bare hand-over would leave the piece with no courier
-- assigned, which is exactly the row the new Collection tab cannot show.
drop function if exists public.fm_hand_over_stage(uuid);

/**
 * Release the piece to a named delivery person, bound for a named partner.
 *
 * The partner is validated against the DESTINATION stage's type where the
 * partner has one — sending a press-only partner a clipping job is a mistake
 * worth refusing at the point it is made, not discovering when the piece comes
 * back wrong.
 */
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

  v_hist := public.log_repeat_stage(p_repeat_id, 'awaiting_dp_collection', st.id, null,
              'Handed over for ' || replace(v_next.stage_type, '_', ' ') ||
              ' — ' || v_partner.name || ', collected by ' ||
              coalesce((select display_name from public.profiles where id = p_delivery_id), 'delivery'));

  -- Stamp the destination onto the history row so the journey summary (Fix 7)
  -- can show where a piece was sent from the moment it was sent, rather than
  -- only once it arrives.
  update public.repeat_stage_history set partner_id = p_partner_id where id = v_hist;

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;


-- ---------------------------------------------------------------------------
-- FIX 5 — the Delivery Person's three tabs.
--
-- The single Orders list becomes Collection / Delivery / Pickup. The rows are
-- the same rows; what changes is that the queue is now MINE — scoped to the
-- delivery person the Floor Manager actually chose — and that the partner is no
-- longer picked here.
--
-- `tab` is computed in SQL rather than in the client. Which tab a status belongs
-- to is part of the workflow definition, and a client that decides for itself
-- can put a piece in a tab whose action the database will then refuse.
--
-- THE NULL CASE IS DELIBERATE. Pieces already in flight when this file runs have
-- no `current_delivery_id`, and so does anything handed over by an older client.
-- Those rows are visible to EVERY delivery person rather than to none: an
-- unassigned piece someone can still move is a queue entry, an unassigned piece
-- nobody can see is a lost parcel.
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
    -- Cast is load-bearing, not decoration: the branches are untyped literals,
    -- so without it the CASE resolves to `unknown` and the whole function fails
    -- at run time with "structure of query does not match function result type".
    (case r.current_status
      when 'awaiting_dp_collection' then 'collection'
      when 'handed_over'            then 'delivery'
      else                               'pickup'
    end)::text,
    r.current_partner_id, fp.name,
    -- The stage the piece is being taken FOR — the one after the stage it has
    -- just cleared. This is what the Floor Manager's button named.
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
    and r.current_status in (
      'awaiting_dp_collection', 'handed_over', 'handed_off', 'returned_to_delivery'
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
    (r.partner_ready_at is not null) desc,
    r.updated_at desc,
    r.repeat_code;
end $$;

-- The delivery person no longer chooses the handler, so the call that made that
-- choice goes. Its replacement carries the custody photo the rest of the app's
-- transfers already carry, and reads the partner the Floor Manager named.
drop function if exists public.dp_send_to_partner(uuid, uuid);

/**
 * Hand the piece to the finishing partner. Photo required. Starts the SLA clock.
 *
 * Writes `handed_off_at` / `partner_id` onto the same history row the status
 * change created, exactly as 0056's dp_send_to_partner did, so
 * `check_sla_breaches` (0020) keeps working untouched.
 *
 * `p_partner_id` is a fallback, not a choice: it is used ONLY when the repeat
 * carries no partner, which can only be a piece handed over by a pre-0084
 * client. New work always uses the Floor Manager's selection.
 */
create or replace function public.dp_handover_to_partner(
  p_repeat_id  uuid,
  p_photo_url  text,
  p_partner_id uuid default null
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory   uuid := public.current_factory_id();
  v_repeat    public.repeats;
  st          public.order_stages;
  v_partner   uuid;
  v_hist      uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'handed_over' then
    raise exception 'This repeat is not with the delivery person (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;
  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A handover photo is required.' using errcode = '22023';
  end if;

  v_partner := coalesce(v_repeat.current_partner_id, p_partner_id);
  if v_partner is null then
    raise exception 'No finishing partner is set for this piece.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.finishing_partners
     where id = v_partner and factory_id = v_factory and deleted_at is null
  ) then
    perform public.raise_not_found('Finishing partner not found.');
  end if;

  st := public.repeat_current_stage(p_repeat_id);

  update public.repeats set current_partner_id = v_partner where id = p_repeat_id;

  -- Captured into a variable first, deliberately: log_repeat_stage is VOLATILE,
  -- and calling it inline in an UPDATE's WHERE clause risks per-row evaluation
  -- and therefore several history rows for one handoff (0056).
  v_hist := public.log_repeat_stage(p_repeat_id, 'handed_off', st.id, p_photo_url,
              'Handed over to finishing partner');

  update public.repeat_stage_history
     set handed_off_at = now(), partner_id = v_partner
   where id = v_hist;

  update public.orders
     set status = 'in_finishing', updated_at = now()
   where id = st.order_id and status = 'in_production';

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;


-- ---------------------------------------------------------------------------
-- FIX 6 — work coming back from a partner is inspected before it advances.
--
-- 0056's fm_confirm_collection advanced the stage index and opened the next
-- stage straight at `in_progress`. Read against the cycle at the top of this
-- file, that meant the partner's work — the entire reason the piece left the
-- building — passed through no checkpoint at all. Every other transition in
-- this app has one.
--
-- Collection now advances the index onto the stage the partner did, and parks
-- the piece at `stage_qa`. From there Fix 3's Pass QA (photo) or the existing
-- Mark damage applies, and Pass QA decides whether the piece goes out again or
-- to Final QA.
--
-- The last-stage branch is kept even though Fix 3 means a piece should never
-- reach collection on its final stage. It costs one comparison and it is the
-- difference between a stranded repeat and a completed one if anything ever
-- does.
-- ---------------------------------------------------------------------------
create or replace function public.fm_confirm_collection(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat   public.repeats;
  v_order_id uuid;
  v_total    int;
  v_next     public.order_stages;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'awaiting_fm_collection' then
    raise exception 'This repeat is not awaiting collection (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;
  select count(*) into v_total from public.order_stages where order_id = v_order_id;

  -- The leg is closed: the courier and the handler belong to it, not to whatever
  -- the piece does next.
  update public.repeats
     set current_partner_id = null,
         current_delivery_id = null,
         partner_ready_at = null
   where id = p_repeat_id;

  if v_repeat.current_stage_index < v_total then
    select * into v_next from public.order_stages
     where order_id = v_order_id and sequence = v_repeat.current_stage_index + 1;

    update public.repeats
       set current_stage_index = current_stage_index + 1
     where id = p_repeat_id;

    -- Straight to Stage QA: the partner's work is what is being inspected.
    perform public.log_repeat_stage(p_repeat_id, 'stage_qa', v_next.id, null,
      'Collected back — ' || replace(v_next.stage_type, '_', ' ') || ' work awaiting Stage QA');

    -- The piece is back on the floor, so the order reads as in production again.
    update public.orders
       set status = 'in_production', updated_at = now()
     where id = v_order_id and status = 'in_finishing';
  else
    perform public.log_repeat_stage(p_repeat_id, 'awaiting_final_qa', null, null,
      'All stages complete');
  end if;

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;


-- ---------------------------------------------------------------------------
-- FIX 7 — the whole journey, in one read.
--
-- Final QA was a pass/fail button over a list of repeat codes. Whoever pressed
-- it had no way to see what they were approving without opening each repeat's
-- History panel one at a time, and nobody reviewing the order later had any way
-- at all.
--
-- `repeat_stage_history` has held everything needed since Phase 3 — status,
-- stage, actor, photo, note, and the handoff/return timestamps. This is a read
-- over it, resolved to names, for every repeat on an order at once. Nothing new
-- is recorded; the record was already there and simply unreadable.
-- ---------------------------------------------------------------------------
create or replace function public.fm_order_journey(p_order_id uuid)
returns table (
  history_id     uuid,
  repeat_id      uuid,
  repeat_code    text,
  stage_sequence int,
  stage_type     text,
  status         text,
  note           text,
  actor_name     text,
  actor_role     text,
  partner_name   text,
  photo_url      text,
  return_photo_url text,
  handed_off_at  timestamptz,
  returned_at    timestamptz,
  created_at     timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'qa', 'company_admin']);

  if not exists (
    select 1 from public.orders o where o.id = p_order_id and o.factory_id = v_factory
  ) then
    perform public.raise_not_found('Order not found.');
  end if;

  return query
  select h.id, r.id, r.repeat_code,
         os.sequence, os.stage_type,
         h.status, h.note,
         pr.display_name, pr.role,
         fp.name,
         h.photo_url, h.return_photo_url,
         h.handed_off_at, h.returned_at, h.created_at
    from public.repeat_stage_history h
    join public.repeats r on r.id = h.repeat_id
    join public.sheets s on s.id = r.sheet_id
    left join public.order_stages os on os.id = h.order_stage_id
    left join public.profiles pr on pr.id = h.actor_user_id
    left join public.finishing_partners fp on fp.id = h.partner_id
   where s.order_id = p_order_id
     and h.factory_id = v_factory
   order by r.repeat_code, h.created_at;
end $$;


-- ---------------------------------------------------------------------------
-- The notification banners must agree with the tabs.
--
-- The four delivery banners (`dp_collect`, `dp_send`, `dp_pickup`,
-- `dp_handback`) counted every piece in the factory at that status. That was
-- right while the queue was factory-wide. Now that the queue is MINE, a banner
-- reading "3 pieces to collect" over a Collection tab holding one would be a
-- number that looks authoritative and is wrong — 0080's header calls that out as
-- the worse of the two failure modes, and it is the same bug again.
--
-- Both functions below are their CURRENT text — my_queue_summary from 0080,
-- my_queue_items from 0079 — with one predicate injected, GENERATED from those
-- files rather than retyped. Retyping either from an older version would drop
-- everything added between it and now, which is exactly what 0077 documents.
-- ---------------------------------------------------------------------------

/**
 * Can the caller see a piece assigned to `p_delivery_id`?
 *
 * One definition, used by the queue and by both halves of the banner system, so
 * the three of them cannot disagree about whose work a piece is. A null
 * assignment is visible to EVERY delivery person: those are pieces handed over
 * before 0084, and an unassigned piece nobody can see is a lost parcel.
 */
create or replace function public.dp_sees_repeat(p_delivery_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_user_role() = 'company_admin'
      or p_delivery_id is null
      or p_delivery_id = auth.uid();
$$;

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
  v_role    text := public.current_user_role();
  v_uid     uuid := auth.uid();
  v_partner uuid;
  n         int;
begin
  if v_factory is null or v_role is null then
    return;   -- super admin / unlinked user has no per-factory queue
  end if;

  if v_role in ('floor_manager', 'company_admin') then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared');
    if n > 0 then
      return query select 'awaiting_job_card', 'Orders awaiting a job card', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a job card',
        'Set the stage sequence so production can be planned',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.material_issues mi
     where mi.factory_id = v_factory and mi.accepted_at is null;
    if n > 0 then
      return query select 'accept_inventory', 'Material ready to accept', n,
        n || ' order' || case when n = 1 then '' else 's' end || ' ready to accept material',
        'Materials are waiting in the store — accept to start production',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_fm_collection';
    if n > 0 then
      return query select 'fm_collect', 'Pieces back from delivery', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' waiting to be collected',
        'The delivery person has handed these back — confirm you have them',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handover_for_delivery';
    if n > 0 then
      return query select 'fm_handover', 'Stages ready to hand over', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to hand over',
        'Passed stage QA — hand to the delivery person',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_final_qa';
    if n > 0 then
      return query select 'fm_final_qa', 'Awaiting your final QA', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' final QA',
        'Check each one before it goes to QA for the final pass',
        v_role = 'floor_manager';
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
         and (v_role = 'company_admin' or m.managed_by = v_uid or m.managed_by is null);
      if n > 0 then
        return query select 'fm_shift_close', 'Shifts still open', n,
          n || ' shift' || case when n = 1 then '' else 's' end || ' still open',
          'Close each one to record stitches and pay the worker',
          v_role = 'floor_manager';
      end if;
    end if;

    -- NEW — the dashboard's "Leave" card already counts these.
    select count(*) into n from public.leaves l
     where l.factory_id = v_factory and l.status = 'pending';
    if n > 0 then
      return query select 'fm_leave', 'Leave requests', n,
        n || ' leave request' || case when n = 1 then '' else 's' end || ' to decide',
        'A worker is waiting on your approval',
        v_role = 'floor_manager';
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
        v_role = 'floor_manager';
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
        v_role = 'floor_manager';
    end if;
  end if;

  if v_role in ('store_manager', 'company_admin') then
    select count(*) into n from public.job_cards jc
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id);
    if n > 0 then
      return query select 'material_requests', 'Material requests', n,
        n || ' material request' || case when n = 1 then '' else 's' end || ' waiting',
        'The floor cannot start production until these are issued',
        v_role = 'store_manager';
    end if;

    select count(*) into n from public.grns g
     where g.factory_id = v_factory and g.status = 'pending';
    if n > 0 then
      return query select 'grn_pending', 'Deliveries to confirm', n,
        n || ' deliver' || case when n = 1 then 'y' else 'ies' end || case when n = 1 then ' needs' else ' need' end || ' checking in',
        'Confirm what actually arrived against the purchase order',
        v_role = 'store_manager';
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
        v_role = 'store_manager';
    end if;
  end if;

  if v_role in ('qa', 'company_admin') then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_cloth_inspection','awaiting_coding');
    if n > 0 then
      return query select 'qa_inspection', 'Orders awaiting inspection', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' inspection',
        'Check the cloth, then code each piece',
        v_role = 'qa';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'stage_qa';
    if n > 0 then
      return query select 'qa_stage', 'Stage QA waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' stage QA',
        'Pass or mark damage before the stage can move on',
        v_role = 'qa';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_qa_final';
    if n > 0 then
      return query select 'qa_final', 'Final pass waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a final pass',
        'Photograph the finished product and pass it',
        v_role = 'qa';
    end if;
  end if;

  if v_role in ('delivery', 'company_admin') then
    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_dp_collection'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_collect', 'Pieces to collect', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect',
        'Collect from the floor manager — a photo is required',
        v_role = 'delivery';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_over'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_send', 'Pieces to send out', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to send out',
        'Take these to the finishing partner the floor manager chose',
        v_role = 'delivery';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and r.partner_ready_at is not null
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_pickup', 'Finished at the partner', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect back',
        'The finishing partner says these are done',
        v_role = 'delivery';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'returned_to_delivery'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_handback', 'Pieces to hand back', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' to hand back',
        'Return these to the floor manager',
        v_role = 'delivery';
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
          v_role = 'delivery';
      end if;
    end if;
  end if;

  if v_role = 'finishing_partner' then
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

  if v_role in ('order_taker', 'company_admin') then
    select count(*) into n
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (v_role = 'company_admin' or o.created_by = v_uid);
    if n > 0 then
      return query select 'ot_returns', 'Returns to complete', n,
        n || ' return' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' completing',
        'Photograph each piece as it goes back to the vendor',
        v_role = 'order_taker';
    end if;
  end if;

  if v_role in ('accountant', 'company_admin') then
    select count(*) into n from public.invoices i
     where i.factory_id = v_factory and i.status = 'pending';
    if n > 0 then
      return query select 'acct_receivables', 'Unpaid invoices', n,
        n || ' invoice' || case when n = 1 then '' else 's' end || ' unpaid',
        'Money owed to the factory — record payment when it arrives',
        v_role = 'accountant';
    end if;

    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'approved';
    if n > 0 then
      return query select 'acct_payables', 'Bills awaiting payment', n,
        n || ' bill' || case when n = 1 then '' else 's' end || ' waiting to be paid',
        'Approved and due — settle and record the payment',
        v_role = 'accountant';
    end if;
  end if;

  if v_role = 'company_admin' then
    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'pending';
    if n > 0 then
      return query select 'owner_approvals', 'Approvals waiting on you', n,
        n || ' approval' || case when n = 1 then '' else 's' end || ' waiting on you',
        'Nothing moves on these until you decide',
        true;
    end if;
  end if;

  if v_role in ('procurement', 'company_admin') then
    -- `auto_generated` (raised automatically on a stock shortfall) and `draft`
    -- are both pre-execution.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status in ('auto_generated','draft');
    if n > 0 then
      return query select 'po_draft', 'Purchase orders to raise', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to raise',
        'Auto-raised on a stock shortfall — assign a supplier and send',
        v_role = 'procurement';
    end if;

    -- NEW — `executed` and `paid` both sit in the PO screen's "To action"
    -- filter, and both have a button on PoDetail waiting to be pressed. They are
    -- two SEPARATE banners, not one, because they ask for two different things:
    -- upload a bill, versus confirm a physical handover. Merging them would put
    -- the user back to opening the list to find out which.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status = 'executed';
    if n > 0 then
      return query select 'po_bill', 'Supplier bills to upload', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a supplier bill',
        'Sent to the supplier — upload the bill to send it for approval',
        v_role = 'procurement';
    end if;

    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status = 'paid';
    if n > 0 then
      return query select 'po_handover', 'Purchase orders to hand over', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to hand over',
        'Paid — confirm handover so the store can check the goods in',
        v_role = 'procurement';
    end if;
  end if;
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
  v_role    text := public.current_user_role();
  v_uid     uuid := auth.uid();
  v_partner uuid;
begin
  if v_factory is null or v_role is null then
    return;
  end if;

  -- A queue key is not a capability. Asking for another role's queue returns
  -- NOTHING rather than raising, so a stale client requesting a key it no
  -- longer owns degrades to an empty list instead of an error screen.
  if p_queue_key in ('awaiting_job_card','accept_inventory','fm_collect','fm_handover',
                     'fm_final_qa','fm_shift_close','fm_leave')
     and v_role not in ('floor_manager','company_admin') then return; end if;
  if p_queue_key in ('fm_store_handover','fm_material_ready')
     and v_role not in ('floor_manager','company_admin') then return; end if;
  if p_queue_key in ('material_requests','grn_pending')
     and v_role not in ('store_manager','company_admin') then return; end if;
  if p_queue_key in ('qa_inspection','qa_stage','qa_final')
     and v_role not in ('qa','company_admin') then return; end if;
  if p_queue_key in ('dp_collect','dp_send','dp_pickup','dp_handback','dp_final_delivery')
     and v_role not in ('delivery','company_admin') then return; end if;
  if p_queue_key = 'partner_active' and v_role <> 'finishing_partner' then return; end if;
  if p_queue_key = 'ot_returns' and v_role not in ('order_taker','company_admin') then return; end if;
  if p_queue_key in ('acct_receivables','acct_payables')
     and v_role not in ('accountant','company_admin') then return; end if;
  if p_queue_key = 'owner_approvals' and v_role <> 'company_admin' then return; end if;
  if p_queue_key in ('po_draft','po_bill','po_handover')
     and v_role not in ('procurement','company_admin') then return; end if;

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

  elsif p_queue_key in ('fm_collect','fm_handover','fm_final_qa') then
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
       and r.current_status = case p_queue_key
             when 'fm_collect'  then 'awaiting_fm_collection'
             when 'fm_handover' then 'handover_for_delivery'
             else 'awaiting_final_qa' end
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
       and (v_role = 'company_admin' or m.managed_by = v_uid or m.managed_by is null)
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

  elsif p_queue_key in ('qa_stage','qa_final') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '), 'final pass'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory
       and r.current_status = case p_queue_key
             when 'qa_stage' then 'stage_qa' else 'awaiting_qa_final' end
     order by o.created_at, r.repeat_code;

  -- ---- Delivery ----------------------------------------------------------
  elsif p_queue_key in ('dp_collect','dp_send','dp_pickup','dp_handback') then
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
             when 'dp_collect'  then r.current_status = 'awaiting_dp_collection'
             when 'dp_send'     then r.current_status = 'handed_over'
             when 'dp_pickup'   then r.current_status = 'handed_off' and r.partner_ready_at is not null
             else                    r.current_status = 'returned_to_delivery' end
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
       and (v_role = 'company_admin' or o.created_by = v_uid)
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
  -- One branch, three statuses: the row shape and destination (PoDetail) are
  -- identical, only the predicate differs.
  elsif p_queue_key in ('po_draft','po_bill','po_handover') then
    return query
    select po.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier assigned') || ' - ' ||
             (select count(*)::text from public.po_items pi where pi.purchase_order_id = po.id) || ' line(s)',
           po.order_id, null::text, po.id, po.status
      from public.purchase_orders po
      left join public.suppliers s on s.id = po.supplier_id
     where po.factory_id = v_factory
       and case p_queue_key
             when 'po_draft'  then po.status in ('auto_generated','draft')
             when 'po_bill'   then po.status = 'executed'
             else                  po.status = 'paid' end
     order by po.created_at desc;
  end if;
end $$;

grant execute on function public.dp_sees_repeat(uuid)      to authenticated;
grant execute on function public.my_queue_summary()        to authenticated;
grant execute on function public.my_queue_items(text)      to authenticated;


-- ---------------------------------------------------------------------------
-- Heal forward — repeats already in flight when this file runs.
--
-- History is APPENDED rather than rewritten, the same rule 0056 followed: the
-- audit trail should show the migration as an event, not pretend the repeat was
-- always where this file wants it.
--
-- Only one case actually strands. A repeat sitting at `handover_for_delivery` on
-- its LAST stage now has no destination — Fix 4's handover requires a next stage
-- and will refuse it, and no other transition applies. Fix 3 would have sent it
-- to Final QA, so that is where it goes.
--
-- Pieces mid-round-trip (awaiting_dp_collection through awaiting_fm_collection)
-- are left exactly as they are. They have no `current_delivery_id`, which the
-- new queue reads as "visible to every delivery person" — see Fix 5's note — so
-- they keep moving, and their next collection lands them on the new Stage QA
-- checkpoint like everything else.
-- ---------------------------------------------------------------------------
do $$
declare r record; n int := 0;
begin
  for r in
    select rp.id, rp.factory_id
      from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where rp.current_status = 'handover_for_delivery'
       and greatest(rp.current_stage_index, 1) >= (
             select count(*) from public.order_stages os where os.order_id = s.order_id
           )
  loop
    insert into public.repeat_stage_history
      (factory_id, repeat_id, order_stage_id, status, note)
    values
      (r.factory_id, r.id, null, 'awaiting_final_qa',
       'Migrated: the final stage no longer makes a delivery round trip (0084)');

    update public.repeats
       set current_status = 'awaiting_final_qa', updated_at = now()
     where id = r.id;
    n := n + 1;
  end loop;

  if n > 0 then
    raise notice 'moved % repeat(s) from a destination-less handover to Final QA', n;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.fm_material_issue_lines(uuid)                to authenticated;
grant execute on function public.fm_accept_inventory(uuid, text, uuid[])      to authenticated;
grant execute on function public.fm_assign_machine(uuid, uuid)                to authenticated;
grant execute on function public.fm_start_production(uuid)                    to authenticated;
grant execute on function public.qa_pass_stage_qa(uuid, text)                 to authenticated;
grant execute on function public.fm_delivery_people()                         to authenticated;
grant execute on function public.fm_hand_over_stage(uuid, uuid, uuid)         to authenticated;
grant execute on function public.dp_orders_queue()                            to authenticated;
grant execute on function public.dp_handover_to_partner(uuid, text, uuid)     to authenticated;
grant execute on function public.fm_confirm_collection(uuid)                  to authenticated;
grant execute on function public.fm_order_journey(uuid)                       to authenticated;
