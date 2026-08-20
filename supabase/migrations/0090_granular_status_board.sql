-- =============================================================================
-- Factory ERP — the granular status board, for the Floor Manager and the Owner.
--
-- THIS ADDS NO STATE. NOTHING WRITES HERE.
-- ---------------------------------------
-- Every label below is DERIVED from `repeats.current_status` +
-- `repeats.current_stage_index` + the order's own `order_stages`. There is no
-- new column, no new transition and no second place where a piece's position is
-- recorded — which is the whole point: a parallel tracking system is a second
-- answer to "where is this piece", and the two always end up disagreeing.
--
-- THE MAPPING, IN FULL
-- --------------------
-- `current_stage_index` (S) is the stage the piece has LAST CLEARED, not the one
-- it is heading for. It is incremented by `fm_confirm_collection` when the piece
-- comes back on the floor — so through the whole handover/partner/pickup leg it
-- still reads S while the work being done is stage S+1. That is why the four
-- transit statuses below resolve against S+1.
--
--   ready_for_production   S    -> Awaiting <stage S>
--   in_progress            S    -> In <stage S>                  (in-house work)
--   stage_qa               S    -> Repeat Inspection after <stage S>
--   handover_for_delivery  S    -> With Manager after <stage S>
--   awaiting_dp_collection S    -> Handover to <stage S+1> - In Delivery
--   handed_over            S    -> Handover to <stage S+1> - In Delivery
--   handed_off             S    -> In <stage S+1>                (partner work)
--   returned_to_delivery   S    -> In Pickup from <stage S+1>
--   awaiting_fm_collection S    -> In Pickup from <stage S+1>
--   awaiting_final_qa           -> Final Inspection by Manager
--   awaiting_qa_final           -> Final Inspection by Manager    (retired by 0087)
--   completed                   -> Ready to Deliver / Delivered   (by orders.delivered_at)
--   damaged                     -> Damaged
--
-- `awaiting_dp_collection` and `handed_over` collapse to ONE label on purpose:
-- they are the delivery person's Collection and Delivery tabs, and from the
-- floor's side both mean "it left me and has not reached the partner". Same for
-- `returned_to_delivery` / `awaiting_fm_collection`, which are Pickup and
-- handed-back.
--
-- ONLY TWO ROLES CAN READ IT
-- --------------------------
-- `assert_role(array['floor_manager','company_admin'])` in both functions, so
-- the restriction is in the database rather than in a screen nobody else has a
-- route to. QA, the store manager, delivery, the order taker and the accountant
-- all keep the views they already have.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. status + stage index -> a stable key
--
-- IMMUTABLE and argument-only: no lookups, so it can be used in a WHERE, a
-- GROUP BY and an index expression alike, and both boards derive their rows
-- from the same one rule.
--
-- The key carries the stage NUMBER, not its name — a job card with Press but no
-- Piko numbers its stages 1,2,3 and the label is resolved from `order_stages`
-- at read time. Nothing here assumes four stages or any particular set.
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
    when 'handover_for_delivery'  then 'mgr:'      || greatest(coalesce(p_stage_index, 1), 1)
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
  'Granular status key for a repeat. Derived only — see 0090. `done` is split '
  'into ready/delivered by the caller, which is the only part that needs the order.';

/** "clipping" -> "Clipping". One place, so both boards spell a stage the same. */
create or replace function public.stage_display_name(p_stage_type text)
returns text
language sql immutable set search_path = public as $$
  select initcap(replace(coalesce(p_stage_type, 'stage'), '_', ' '))
$$;

-- ---------------------------------------------------------------------------
-- 2. Repeat-level board — every repeat, where it is right now
--
-- `photo_url` is the evidence attached to the piece's CURRENT position: the
-- newest history row that carries one. Those photos are the collection,
-- handover, pickup and Stage QA captures the existing mechanics already
-- require — nothing new is captured to fill this column.
-- ---------------------------------------------------------------------------
create or replace function public.fm_repeat_status_board(p_order_id uuid)
returns table (
  repeat_id    uuid,
  repeat_code  text,
  status_key   text,
  status_label text,
  raw_status   text,
  stage_index  int,
  sequence     int,
  at           timestamptz,
  photo_url    text,
  sla_breached boolean,
  partner_name text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_total   int;
begin
  perform public.assert_module('order_lifecycle');
  -- The visibility restriction, in the database. Not a hidden screen.
  perform public.assert_role(array['floor_manager','company_admin']);

  if not exists (
    select 1 from public.orders o where o.id = p_order_id and o.factory_id = v_factory
  ) then
    perform public.raise_not_found('Order not found.');
  end if;

  select count(*) into v_total from public.order_stages where order_id = p_order_id;

  return query
  with base as (
    select r.id, r.repeat_code, r.current_status, r.current_stage_index,
           r.updated_at, r.current_partner_id,
           public.repeat_status_key(r.current_status, r.current_stage_index) as k
      from public.repeats r
      join public.sheets s on s.id = r.sheet_id
     where s.order_id = p_order_id and r.factory_id = v_factory
  ),
  resolved as (
    select b.*,
           -- `done` is the only key that needs the order to disambiguate.
           case
             when b.k = 'done' and o.delivered_at is not null then 'delivered'
             when b.k = 'done' then 'ready'
             else b.k
           end as key2,
           -- The stage number embedded in the key, for the label lookup.
           case when b.k like '%:%' then split_part(b.k, ':', 2)::int else null end as seq
      from base b
      join public.orders o on o.id = p_order_id
  )
  select
    x.id, x.repeat_code, x.key2,
    case
      when x.key2 like 'pre:%'      then 'Awaiting ' || public.stage_display_name(st.stage_type)
      when x.key2 like 'in:%'       then 'In ' || public.stage_display_name(st.stage_type)
      when x.key2 like 'qa:%'       then 'Repeat Inspection after ' || public.stage_display_name(st.stage_type)
      when x.key2 like 'mgr:%'      then 'With Manager after ' || public.stage_display_name(st.stage_type)
      when x.key2 like 'handover:%' then 'Handover to ' || public.stage_display_name(st.stage_type) || ' - In Delivery'
      when x.key2 like 'pickup:%'   then 'In Pickup from ' || public.stage_display_name(st.stage_type)
      when x.key2 = 'final'         then 'Final Inspection by Manager'
      when x.key2 = 'ready'         then 'Ready to Deliver'
      when x.key2 = 'delivered'     then 'Delivered'
      when x.key2 = 'damaged'       then 'Damaged'
      when x.key2 = 'precoded'      then 'Awaiting job card'
      else 'Not started'
    end,
    x.current_status,
    x.current_stage_index,
    x.seq,
    x.updated_at,
    (select h.photo_url from public.repeat_stage_history h
      where h.repeat_id = x.id and h.photo_url is not null
      order by h.created_at desc limit 1),
    exists (select 1 from public.sla_alerts a
             where a.repeat_id = x.id and a.resolved_at is null),
    fp.name
  from resolved x
  left join public.order_stages st
         on st.order_id = p_order_id and st.sequence = x.seq
  left join public.finishing_partners fp on fp.id = x.current_partner_id
  order by x.repeat_code;
end $$;

grant execute on function public.repeat_status_key(text, int)    to authenticated;
grant execute on function public.stage_display_name(text)        to authenticated;
grant execute on function public.fm_repeat_status_board(uuid)    to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Order-level board — the whole sequence, with a live count on each row
--
-- Six milestones, then the per-stage rows generated from THIS order's
-- `order_stages` (so an order without Piko simply has no Piko rows), then the
-- tail. Every stage row carries how many of the order's repeats are sitting at
-- exactly that status right now — different pieces are at different points, and
-- one "order status" cannot say that.
--
-- The last stage gets no "With Manager after ..." row: `qa_pass_stage_qa` sends
-- a piece that clears the final stage straight to Final Inspection, so that row
-- could never be anything but zero.
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
    -- it — the piece is already on the floor.
    select os.sequence, os.stage_type, os.id as stage_id, g.slot, g.ord
      from public.order_stages os
      cross join lateral (
        values
          ('handover', 1), ('in', 2), ('pickup', 3), ('qa', 4), ('mgr', 5)
      ) as g(slot, ord)
     where os.order_id = p_order_id
       -- No transit rows before the first stage, and no "with manager" after
       -- the last one (that piece goes straight to Final Inspection).
       and not (os.sequence = 1 and g.slot in ('handover', 'pickup'))
       and not (os.sequence = v_total and g.slot = 'mgr')
  )
  select
    rw.slot || ':' || rw.sequence,
    case rw.slot
      when 'handover' then 'Handover to ' || public.stage_display_name(rw.stage_type) || ' - In Delivery'
      when 'in'       then 'In ' || public.stage_display_name(rw.stage_type)
      when 'pickup'   then 'In Pickup after ' || public.stage_display_name(rw.stage_type)
      when 'qa'       then 'Repeat Inspection after ' || public.stage_display_name(rw.stage_type)
      else                 'With Manager after ' || public.stage_display_name(rw.stage_type)
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
     * stage those states are named after — see the header. The two in-place
     * states (`qa`, `mgr`) carry their own stage. Getting this backwards would
     * put the clipping handover photo under embroidery.
     */
    select h.photo_url, h.created_at as at
      from public.repeat_stage_history h
      join public.repeats rp on rp.id = h.repeat_id
      join public.sheets s on s.id = rp.sheet_id
      join public.order_stages hs on hs.id = h.order_stage_id
     where s.order_id = p_order_id
       and h.photo_url is not null
       and case rw.slot
             when 'handover' then h.status in ('awaiting_dp_collection','handed_over')
                                   and hs.sequence = rw.sequence - 1
             when 'pickup'   then h.status in ('returned_to_delivery','awaiting_fm_collection')
                                   and hs.sequence = rw.sequence - 1
             when 'in'       then (h.status = 'handed_off' and hs.sequence = rw.sequence - 1)
                                   or (h.status = 'in_progress' and hs.sequence = rw.sequence)
             when 'qa'       then h.status = 'stage_qa' and hs.sequence = rw.sequence
             else                 h.status = 'handover_for_delivery' and hs.sequence = rw.sequence
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
