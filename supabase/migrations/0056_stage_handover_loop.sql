-- =============================================================================
-- Factory ERP — The full stage handover loop (SUPERSEDES 0043/0045's simple loop)
--
-- WHAT CHANGED AND WHY
-- --------------------
-- 0045 implemented the short loop:
--     awaiting_stage -> in_progress -> stage_qa -> awaiting_stage (next stage)
-- The revised brief replaces that with a longer per-stage cycle that routes the
-- physical piece through the Delivery Person on BOTH legs — out to a finishing
-- partner and back again — with a photo at each physical custody change.
--
-- Two structural consequences, both deliberate:
--
--   1. `awaiting_stage` IS NO LONGER PRODUCED. A stage becomes `in_progress`
--      the moment it is its turn — on Start Production for stage 1, and on the
--      Floor Manager's collection confirmation for every stage after that.
--      There is no "Start stage" action anywhere any more, so `fm_start_stage`
--      is dropped rather than left callable: leaving a dead RPC that can move a
--      repeat into a status nothing else understands is how state machines rot.
--      The VALUE stays in the CHECK constraint because historical
--      repeat_stage_history rows legitimately contain it — dropping it would
--      make the audit trail unreadable. Live repeats sitting there are healed
--      forward at the bottom of this file.
--
--   2. THE SLA MACHINERY IS REUSED, NOT REBUILT. `handed_off` keeps its exact
--      Phase 6 meaning — "physically out at a finishing partner" — and the
--      out/back legs keep writing `handed_off_at` / `returned_at` on the same
--      repeat_stage_history row. That is what `check_sla_breaches` (0020)
--      scans, so the existing SLA timer starts and resolves with no change to
--      the scanner or the alerts table.
--
-- THE NEW PER-STAGE CYCLE (statuses in order)
-- ------------------------------------------
--   in_progress            FM works the stage.            -> Go to QA
--   stage_qa               QA passes or rejects.          -> (QA) Pass
--   handover_for_delivery  QA passed; piece is ready.     -> (FM) Hand over
--   awaiting_dp_collection FM released it.                -> (DP) Collect +photo
--   handed_over            DP physically holds it.        -> (DP) pick handler,
--                          FM sees "Handed Over";            send to partner
--                          DP sees "Delivery waiting"
--   handed_off             Out at the partner. SLA RUNS.  -> (DP) Collect +photo
--   returned_to_delivery   DP has it back from partner.   -> (DP) Hand back
--   awaiting_fm_collection FM is prompted to confirm.     -> (FM) Collect
--   ...then the NEXT stage opens directly at in_progress, or, if that was the
--   last stage in the order's sequence, the repeat lands on awaiting_final_qa.
--
-- ONE STATUS, TWO LABELS: `handed_over` is deliberately a single status even
-- though the brief names it "Handed Over" (Floor Manager) and "Delivery
-- waiting" (Delivery Person). It is one physical fact — the Delivery Person is
-- holding the piece — seen from two sides. Splitting it into two statuses would
-- mean two rows of truth for one custody state, and every query would have to
-- remember to check both. The two labels live in the UI's pill maps instead.
--
-- FINAL SEQUENCE (Fix 5)
-- ---------------------
--   awaiting_final_qa   FM's Final QA check   -> fm_final_qa_pass
--   awaiting_qa_final   QA's actual final pass -> qa_final_pass
--   completed           order flips to ready_for_delivery once every repeat is
--                       here; the Order Taker's board is READ-ONLY and simply
--                       reflects it.
--
-- `fm_final_qa_pass` keeps its name and signature (Phase 7's Final QA screen
-- and the invoicing guard both call it) but now lands on `awaiting_qa_final`
-- instead of `completed`. Invoicing still requires every repeat `completed`,
-- so an order cannot be billed until QA has done the real final pass.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Statuses
-- ---------------------------------------------------------------------------
alter table public.repeats drop constraint if exists repeats_current_status_check;
alter table public.repeats add constraint repeats_current_status_check
  check (current_status in (
    'coded',
    'awaiting_job_card',
    'ready_for_production',
    'awaiting_stage',            -- retained for history readability; not produced
    'in_progress',
    'stage_qa',
    'handover_for_delivery',     -- NEW
    'awaiting_dp_collection',    -- NEW
    'handed_over',               -- NEW
    'in_production',
    'in_finishing',
    'handed_off',
    'returned_to_delivery',      -- NEW
    'awaiting_fm_collection',    -- NEW
    'awaiting_collection_qa',
    'awaiting_final_qa',
    'awaiting_qa_final',         -- NEW
    'completed',
    'damaged'
  ));

-- Which partner/handler the Delivery Person picked for the stage in flight, and
-- the custody photos. These sit on `repeats` as the CURRENT leg's working state;
-- the durable evidence trail stays in repeat_stage_history, as always.
alter table public.repeats
  add column if not exists current_partner_id      uuid references public.finishing_partners(id) on delete set null,
  add column if not exists dp_collected_photo_url  text,
  add column if not exists dp_returned_photo_url   text;

-- ---------------------------------------------------------------------------
-- 2. Shared helper: resolve a repeat + its order, tenant-checked.
--
-- Every function below is SECURITY DEFINER, so RLS does not protect them from
-- the inside. This is THE tenant guard for the whole file — a repeat from
-- another factory must 404, never leak.
-- ---------------------------------------------------------------------------
create or replace function public.assert_my_repeat(p_repeat_id uuid)
returns public.repeats
language plpgsql stable security definer set search_path = public as $$
declare r public.repeats;
begin
  select * into r from public.repeats
   where id = p_repeat_id and factory_id = public.current_factory_id();
  if not found then perform public.raise_not_found('Repeat not found.'); end if;
  return r;
end $$;

/** The order_stages row a repeat is currently working through (1-based index). */
create or replace function public.repeat_current_stage(p_repeat_id uuid)
returns public.order_stages
language plpgsql stable security definer set search_path = public as $$
declare
  v_repeat public.repeats;
  v_order  uuid;
  st       public.order_stages;
begin
  select * into v_repeat from public.repeats where id = p_repeat_id;
  select s.order_id into v_order from public.sheets s where s.id = v_repeat.sheet_id;
  select * into st from public.order_stages
   where order_id = v_order and sequence = greatest(v_repeat.current_stage_index, 1);
  return st;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Start Production now opens stage 1 directly at in_progress (Fix 4, step 0)
-- ---------------------------------------------------------------------------
create or replace function public.fm_start_production(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_first uuid;
  r       record;
  v_moved int := 0;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'machine_selection_pending' then
    raise exception 'This order is not awaiting production start (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if v_order.assigned_machine_id is null then
    raise exception 'Assign a machine before starting production.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.shifts
     where machine_id = v_order.assigned_machine_id and status = 'open'
  ) then
    raise exception 'The assigned machine does not currently have an active shift.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.order_stages where order_id = p_order_id) then
    raise exception 'This order has no stages configured on its job card.' using errcode = '22023';
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
    -- Straight to in_progress: there is no "Start stage" step any more.
    update public.repeats set current_stage_index = 1 where id = r.id;
    perform public.log_repeat_stage(r.id, 'in_progress', v_first, null, 'Production started');
    v_moved := v_moved + 1;
  end loop;

  return jsonb_build_object('order_id', p_order_id, 'status', 'in_production', 'repeats_advanced', v_moved);
end $$;

-- The "Start stage" action no longer exists in the flow. Dropped rather than
-- left in place — see the header note on dead transitions.
drop function if exists public.fm_start_stage(uuid);

-- ---------------------------------------------------------------------------
-- 4. Stage QA pass now hands to the Delivery leg, not to the next stage (step 3)
-- ---------------------------------------------------------------------------
create or replace function public.qa_pass_stage_qa(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat public.repeats;
  st       public.order_stages;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'stage_qa' then
    raise exception 'This repeat is not at Stage QA (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  st := public.repeat_current_stage(p_repeat_id);

  -- Every stage now leaves the floor via the Delivery Person, so there is no
  -- last-stage special case here any more: the cycle always continues to
  -- handover, and the decision about what comes next is made at the far end,
  -- in fm_confirm_collection.
  perform public.log_repeat_stage(p_repeat_id, 'handover_for_delivery', st.id, null,
    'Stage QA passed — ready for handover');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Floor Manager hands the stage to the Delivery Person (step 3 -> 4)
-- ---------------------------------------------------------------------------
create or replace function public.fm_hand_over_stage(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat public.repeats;
  st       public.order_stages;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'handover_for_delivery' then
    raise exception 'This repeat is not ready for handover (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  st := public.repeat_current_stage(p_repeat_id);
  perform public.log_repeat_stage(p_repeat_id, 'awaiting_dp_collection', st.id, null,
    'Handed over — awaiting delivery collection');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Delivery Person collects FROM the Floor Manager (step 4). Photo required.
--
-- The moment this succeeds the Floor Manager's view reads "Handed Over" — that
-- is this same status seen from the floor side.
-- ---------------------------------------------------------------------------
create or replace function public.dp_collect_from_floor(
  p_repeat_id uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat public.repeats;
  st       public.order_stages;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'awaiting_dp_collection' then
    raise exception 'This repeat is not awaiting collection (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;
  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A collection photo is required.' using errcode = '22023';
  end if;

  st := public.repeat_current_stage(p_repeat_id);

  update public.repeats
     set dp_collected_photo_url = p_photo_url
   where id = p_repeat_id;

  perform public.log_repeat_stage(p_repeat_id, 'handed_over', st.id, p_photo_url,
    'Collected from Floor Manager');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Delivery Person picks the handler and sends the piece out (steps 5 -> 6)
--
-- This is the leg that starts the SLA timer. It writes `handed_off_at` and
-- `partner_id` onto a repeat_stage_history row exactly the way Phase 6's
-- dp_confirm_handoff did, so `check_sla_breaches` picks it up unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.dp_send_to_partner(
  p_repeat_id  uuid,
  p_partner_id uuid
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_repeat  public.repeats;
  st        public.order_stages;
  v_hist    uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'handed_over' then
    raise exception 'This repeat is not with the delivery person (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;
  if p_partner_id is null then
    raise exception 'Select who is handling this stage before handing it over.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.finishing_partners
     where id = p_partner_id and factory_id = v_factory and deleted_at is null
  ) then
    perform public.raise_not_found('Finishing partner not found.');
  end if;

  st := public.repeat_current_stage(p_repeat_id);

  update public.repeats set current_partner_id = p_partner_id where id = p_repeat_id;

  -- Status row AND the SLA-bearing handoff row are the same row: log_repeat_stage
  -- writes it, then the handoff columns are stamped onto it. One row per leg
  -- keeps `returned_at` unambiguous when the piece comes back.
  --
  -- The returned id is captured into a variable first, deliberately:
  -- log_repeat_stage is VOLATILE, and calling it inline in an UPDATE's WHERE
  -- clause risks it being evaluated per candidate row — i.e. writing several
  -- history rows for one handoff.
  v_hist := public.log_repeat_stage(p_repeat_id, 'handed_off', st.id, null,
              'Handed over to finishing partner');

  update public.repeat_stage_history
     set handed_off_at = now(), partner_id = p_partner_id
   where id = v_hist;

  -- Order-level: an outsourced stage in flight is what "in finishing" means.
  update public.orders
     set status = 'in_finishing', updated_at = now()
   where id = st.order_id and status = 'in_production';

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Delivery Person collects BACK from the partner (step 7a). Photo required.
--    Closes the SLA window.
-- ---------------------------------------------------------------------------
create or replace function public.dp_collect_from_partner(
  p_repeat_id uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat public.repeats;
  st       public.order_stages;
  v_hist   uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'handed_off' then
    raise exception 'This repeat is not out at a finishing partner (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;
  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A collection photo is required.' using errcode = '22023';
  end if;

  st := public.repeat_current_stage(p_repeat_id);

  -- Close the open handoff leg: this is what stops the SLA clock.
  select id into v_hist
    from public.repeat_stage_history
   where repeat_id = p_repeat_id
     and handed_off_at is not null
     and returned_at is null
   order by handed_off_at desc
   limit 1;

  if v_hist is not null then
    update public.repeat_stage_history
       set returned_at = now(), return_photo_url = p_photo_url
     where id = v_hist;
  end if;

  update public.sla_alerts
     set resolved_at = now()
   where repeat_id = p_repeat_id and order_stage_id = st.id and resolved_at is null;

  update public.repeats set dp_returned_photo_url = p_photo_url where id = p_repeat_id;

  perform public.log_repeat_stage(p_repeat_id, 'returned_to_delivery', st.id, p_photo_url,
    'Collected back from finishing partner');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Delivery Person hands back to the Floor Manager (step 7b)
--
-- This is what raises the Floor Manager's "Collect [stage]" prompt — the
-- prompt is not a separate notification table, it is simply every repeat on
-- the order sitting at `awaiting_fm_collection`, which fm_pending_collections
-- below reads back.
-- ---------------------------------------------------------------------------
create or replace function public.dp_hand_back_to_floor(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat public.repeats;
  st       public.order_stages;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'returned_to_delivery' then
    raise exception 'This repeat has not been collected back yet (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  st := public.repeat_current_stage(p_repeat_id);
  perform public.log_repeat_stage(p_repeat_id, 'awaiting_fm_collection', st.id, null,
    'Handed back to Floor Manager');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Floor Manager confirms collection -> NEXT STAGE OPENS AUTOMATICALLY (step 8)
-- ---------------------------------------------------------------------------
create or replace function public.fm_confirm_collection(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat   public.repeats;
  v_order_id uuid;
  v_total    int;
  v_next     uuid;
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

  -- The stage that just finished is released; the partner assignment belongs to
  -- that leg only and must not carry into the next one.
  update public.repeats set current_partner_id = null where id = p_repeat_id;

  if v_repeat.current_stage_index < v_total then
    select id into v_next from public.order_stages
     where order_id = v_order_id and sequence = v_repeat.current_stage_index + 1;

    update public.repeats
       set current_stage_index = current_stage_index + 1
     where id = p_repeat_id;

    -- Automatically In Progress — no "Start stage" button exists any more.
    perform public.log_repeat_stage(p_repeat_id, 'in_progress', v_next, null,
      'Collected — next stage started');

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
-- 11. Final sequence (Fix 5)
--
-- fm_final_qa_pass keeps its name/signature — Phase 7's Final QA screen and the
-- invoicing guard both call it — but it is now the FIRST of two gates.
-- ---------------------------------------------------------------------------
create or replace function public.fm_final_qa_pass(p_repeat_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_repeat public.repeats;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'awaiting_final_qa' then
    raise exception 'This repeat is not awaiting final QA (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  perform public.log_repeat_stage(p_repeat_id, 'awaiting_qa_final', null, null,
    coalesce(p_note, 'Floor Manager final QA done — sent to QA'));

  return jsonb_build_object('repeat_id', p_repeat_id, 'status', 'awaiting_qa_final');
end $$;

/** The actual final pass. QA only. This is what completes a repeat. */
create or replace function public.qa_final_pass(p_repeat_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_repeat   public.repeats;
  v_order_id uuid;
  v_pending  int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'awaiting_qa_final' then
    raise exception 'This repeat has not cleared the Floor Manager''s final QA (status: %).',
      v_repeat.current_status using errcode = '22023';
  end if;

  perform public.log_repeat_stage(p_repeat_id, 'completed', null, null,
    coalesce(p_note, 'Passed final QA'));

  -- Order-level roll-up. The Order Taker's board is read-only and simply
  -- reflects this — no action is required from them.
  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  select count(*) into v_pending
    from public.repeats r
    join public.sheets s on s.id = r.sheet_id
   where s.order_id = v_order_id
     and r.current_status not in ('completed', 'damaged');

  if v_pending = 0 then
    update public.orders
       set status = 'ready_for_delivery', updated_at = now()
     where id = v_order_id and status <> 'completed';
  end if;

  return jsonb_build_object(
    'repeat_id', p_repeat_id,
    'status', 'completed',
    'order_ready', v_pending = 0
  );
end $$;

-- ---------------------------------------------------------------------------
-- 12. Delivery Person's single Orders feed (Fix 1)
--
-- ONE query backing ONE tab. Every leg of this role's work — collect from the
-- floor, send to a partner, collect back, hand back — is a row here with the
-- action implied by its status, rather than three separate queues.
-- ---------------------------------------------------------------------------
create or replace function public.dp_orders_queue()
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  vendor_name      text,
  sheet_number     int,
  color_assignment text,
  order_stage_id   uuid,
  stage_type       text,
  stage_sequence   int,
  total_stages     int,
  current_status   text,
  partner_id       uuid,
  partner_name     text,
  sla_hours        int,
  handed_off_at    timestamptz,
  sla_breached     boolean
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
    r.current_partner_id, fp.name, st.sla_hours,
    lastleg.handed_off_at,
    coalesce(
      exists (select 1 from public.sla_alerts a
               where a.repeat_id = r.id and a.resolved_at is null),
      false)
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  left join public.vendors v on v.id = o.vendor_id
  left join public.order_stages st
         on st.order_id = o.id and st.sequence = greatest(r.current_stage_index, 1)
  left join public.finishing_partners fp on fp.id = r.current_partner_id
  left join lateral (
    select h.handed_off_at
      from public.repeat_stage_history h
     where h.repeat_id = r.id and h.handed_off_at is not null and h.returned_at is null
     order by h.handed_off_at desc
     limit 1
  ) lastleg on true
  where r.factory_id = v_factory
    -- Exactly the four statuses this role can act on.
    and r.current_status in (
      'awaiting_dp_collection', 'handed_over', 'handed_off', 'returned_to_delivery'
    )
  order by
    -- Breached first, then oldest work first: the queue sorts itself by urgency.
    (exists (select 1 from public.sla_alerts a
              where a.repeat_id = r.id and a.resolved_at is null)) desc,
    o.created_at asc, r.repeat_code asc;
end $$;

-- ---------------------------------------------------------------------------
-- 13. Floor Manager's "Collect [stage]" prompt feed (step 7)
-- ---------------------------------------------------------------------------
create or replace function public.fm_pending_collections(p_order_id uuid default null)
returns table (
  repeat_id      uuid,
  repeat_code    text,
  order_id       uuid,
  order_code     text,
  stage_type     text,
  stage_sequence int,
  partner_name   text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  return query
  select r.id, r.repeat_code, o.id, o.order_code, st.stage_type, st.sequence, fp.name
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  left join public.order_stages st
         on st.order_id = o.id and st.sequence = greatest(r.current_stage_index, 1)
  left join public.finishing_partners fp on fp.id = r.current_partner_id
  where r.factory_id = v_factory
    and r.current_status = 'awaiting_fm_collection'
    and (p_order_id is null or o.id = p_order_id)
  order by o.created_at asc, r.repeat_code asc;
end $$;

-- ---------------------------------------------------------------------------
-- 14. Heal live repeats left on the retired `awaiting_stage` status
--
-- Their stage is theirs to work now, which is exactly what in_progress means.
-- History is appended (via the normal primitive) rather than rewritten, so the
-- audit trail shows the migration as an event instead of pretending the repeat
-- was never there.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select rp.id, rp.current_stage_index, s.order_id
      from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where rp.current_status = 'awaiting_stage'
  loop
    insert into public.repeat_stage_history
      (factory_id, repeat_id, order_stage_id, status, note)
    select rp.factory_id, r.id,
           (select id from public.order_stages
             where order_id = r.order_id
               and sequence = greatest(r.current_stage_index, 1)),
           'in_progress',
           'Migrated: stages now start automatically (0056)'
      from public.repeats rp where rp.id = r.id;

    update public.repeats
       set current_status = 'in_progress', updated_at = now()
     where id = r.id;
  end loop;
end $$;

grant execute on function public.assert_my_repeat(uuid)                to authenticated;
grant execute on function public.repeat_current_stage(uuid)            to authenticated;
grant execute on function public.fm_hand_over_stage(uuid)              to authenticated;
grant execute on function public.dp_collect_from_floor(uuid, text)     to authenticated;
grant execute on function public.dp_send_to_partner(uuid, uuid)        to authenticated;
grant execute on function public.dp_collect_from_partner(uuid, text)   to authenticated;
grant execute on function public.dp_hand_back_to_floor(uuid)           to authenticated;
grant execute on function public.fm_confirm_collection(uuid)           to authenticated;
grant execute on function public.qa_final_pass(uuid, text)             to authenticated;
grant execute on function public.dp_orders_queue()                     to authenticated;
grant execute on function public.fm_pending_collections(uuid)          to authenticated;
