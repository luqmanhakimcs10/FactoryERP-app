-- =============================================================================
-- Factory ERP — Order Taker Returns: Initial-QA rejections belong here too.
--
-- THE BUG. `ot_return_repeats` (0032/0036) is built entirely on Phase 6
-- finishing data: it starts from `repeats`, and inner-joins a totals CTE with
-- `handoffs > 0`. An Initial-QA rejection (Stage 2, migration 0034) creates
-- NEITHER of those things — `qa_reject_piece` writes a `damage_records` row
-- with `repeat_id IS NULL` and never codes a repeat for that slot, precisely
-- because the piece failed inspection. So the rejection was invisible to the
-- board by construction, and Active returns read (0) while rejected pieces sat
-- waiting to physically go back to the vendor. Verified on the live Alpha
-- project before this change: 2 repeat_qa rejections existed, 0 active rows.
--
-- THE FIX. The board becomes a union of the two things that "physically go
-- back to the vendor", rather than only the finishing one:
--
--   kind = 'finishing'     — what 0032 already returned, unchanged.
--   kind = 'qa_rejection'  — a repeat_qa damage record, resolved by the order
--                            taker confirming the handback.
--
-- Both buckets the same way, both carry Order / Reason / Photo, and both offer
-- Complete return. Because a QA rejection has no repeat, `repeat_id` is null on
-- those rows and `entry_id` is the stable key the UI lists on; `kind` says which
-- completion RPC applies.
--
-- Completion for a QA rejection is a NEW column on damage_records rather than
-- a reuse of `note`: the QA person's note is evidence attached to a damage
-- claim, and overwriting it to record an unrelated logistics event would
-- destroy it. Same reasoning as 0036's separate timestamp column.
--
-- Adding columns to a RETURNS TABLE(...) is a return-type change, so the old
-- signature must be dropped first (same as 0036).
-- =============================================================================

alter table public.damage_records
  add column if not exists ot_return_confirmed_at timestamptz,
  add column if not exists ot_return_note text;

-- ---------------------------------------------------------------------------
-- 1. The widened board.
-- ---------------------------------------------------------------------------
drop function if exists public.ot_return_repeats();

create or replace function public.ot_return_repeats()
returns table (
  repeat_id      uuid,
  repeat_code    text,
  order_id       uuid,
  order_code     text,
  vendor_name    text,
  sheet_number   int,
  color_assignment text,
  current_status text,
  bucket         text,
  stage_type     text,
  partner_name   text,
  handed_off_at  timestamptz,
  returned_at    timestamptz,
  stages_returned int,
  sla_breached   boolean,
  ot_return_confirmed_at timestamptz,
  -- 0054 additions
  kind           text,
  entry_id       uuid,
  damage_id      uuid,
  reason         text,
  photo_url      text,
  note           text,
  piece_index    int,
  piece_total    int,
  occurred_at    timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_factory uuid := public.current_factory_id();
  v_all     boolean := public.current_user_role() = 'company_admin';
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['order_taker','company_admin']);

  return query
  with mine as (
    select o.id, o.order_code, o.vendor_id
      from public.orders o
     where o.factory_id = v_factory
       and (v_all or o.created_by = auth.uid())
  ),
  -- Each sheet's pieces in resolution order — a passed piece (a coded repeat)
  -- and a rejected one (a repeat_qa damage row) occupy the same 1..n slots, so
  -- a rejection reads here exactly as it did on the QA screen that made it
  -- ("Pink — piece 2 of 2") rather than getting its own private numbering.
  slots as (
    select r.sheet_id, 'repeat'::text as slot_kind, r.id as slot_id, r.created_at
      from public.repeats r
     where r.factory_id = v_factory
    union all
    select d.sheet_id, 'damage'::text, d.id, d.created_at
      from public.damage_records d
     where d.factory_id = v_factory
       and d.stage_type = 'repeat_qa'
       and d.repeat_id is null
       and d.sheet_id is not null
  ),
  slot_index as (
    select slot_kind, slot_id, sheet_id,
           row_number() over (partition by sheet_id order by created_at, slot_id)::int as piece_index
      from slots
  ),
  -- ---- finishing side: unchanged from 0032/0036 ----
  rep as (
    select r.id, r.repeat_code, r.current_status, r.ot_return_confirmed_at, r.sheet_id,
           s.sheet_number, s.color_assignment, s.repeats_count,
           mine.id as oid, mine.order_code as ocode, mine.vendor_id as vid
      from public.repeats r
      join public.sheets s on s.id = r.sheet_id
      join mine on mine.id = s.order_id
     where r.factory_id = v_factory
  ),
  last_move as (
    select distinct on (h.repeat_id)
           h.repeat_id, h.order_stage_id, h.partner_id, h.handed_off_at, h.returned_at,
           h.return_photo_url, h.handoff_photo_url
      from public.repeat_stage_history h
     where h.factory_id = v_factory
       and (h.handed_off_at is not null or h.returned_at is not null)
     order by h.repeat_id, coalesce(h.returned_at, h.handed_off_at) desc
  ),
  totals as (
    select h.repeat_id,
           count(*) filter (where h.handed_off_at is not null)::int as handoffs,
           count(*) filter (where h.returned_at is not null)::int as returns
      from public.repeat_stage_history h
     where h.factory_id = v_factory
     group by h.repeat_id
  ),
  -- Why a repeat came back, when there is a reason on file: the newest damage
  -- record against it. Null for a clean return, which is the common case.
  rep_damage as (
    select distinct on (d.repeat_id)
           d.repeat_id, d.damage_type, d.photo_url, d.note
      from public.damage_records d
     where d.factory_id = v_factory
       and d.repeat_id is not null
     order by d.repeat_id, d.created_at desc
  )
  select
    rep.id, rep.repeat_code, rep.oid, rep.ocode,
    coalesce(v.name, '—'),
    rep.sheet_number, rep.color_assignment,
    rep.current_status,
    case
      when rep.current_status in ('awaiting_final_qa','completed') or rep.ot_return_confirmed_at is not null
        then 'completed'
      else 'active'
    end,
    st.stage_type,
    fp.name,
    last_move.handed_off_at,
    last_move.returned_at,
    coalesce(totals.returns, 0),
    exists (
      select 1 from public.sla_alerts a
       where a.repeat_id = rep.id and a.resolved_at is null
    ),
    rep.ot_return_confirmed_at,
    'finishing'::text,
    rep.id,
    null::uuid,
    rep_damage.damage_type,
    coalesce(rep_damage.photo_url, last_move.return_photo_url, last_move.handoff_photo_url),
    rep_damage.note,
    slot_index.piece_index,
    rep.repeats_count,
    coalesce(last_move.returned_at, last_move.handed_off_at)
  from rep
  join totals on totals.repeat_id = rep.id and totals.handoffs > 0
  left join last_move on last_move.repeat_id = rep.id
  left join rep_damage on rep_damage.repeat_id = rep.id
  left join slot_index on slot_index.slot_kind = 'repeat' and slot_index.slot_id = rep.id
  left join public.order_stages st on st.id = last_move.order_stage_id
  left join public.finishing_partners fp on fp.id = last_move.partner_id
  left join public.vendors v on v.id = rep.vid
  where rep.current_status <> 'damaged'

  union all

  -- ---- Initial-QA rejection side (the fix) ----
  select
    null::uuid,
    -- No repeat was ever coded for a rejected piece, so there is no repeat
    -- code to show. The sheet code is what the QA screen and the physical
    -- paperwork both carry.
    coalesce(mine.order_code, '(draft)') || '-S' || s.sheet_number,
    mine.id, mine.order_code,
    coalesce(v.name, '—'),
    s.sheet_number, s.color_assignment,
    'rejected_at_qa'::text,
    case when d.ot_return_confirmed_at is not null then 'completed' else 'active' end,
    'repeat_qa'::text,
    null::text,
    null::timestamptz,
    null::timestamptz,
    0,
    false,
    d.ot_return_confirmed_at,
    'qa_rejection'::text,
    d.id,
    d.id,
    d.damage_type,
    d.photo_url,
    d.note,
    slot_index.piece_index,
    s.repeats_count,
    d.created_at
  from public.damage_records d
  join public.sheets s on s.id = d.sheet_id
  join mine on mine.id = d.order_id
  left join slot_index on slot_index.slot_kind = 'damage' and slot_index.slot_id = d.id
  left join public.vendors v on v.id = mine.vendor_id
  where d.factory_id = v_factory
    and d.stage_type = 'repeat_qa'
    and d.repeat_id is null

  order by 25 desc nulls last, 2;
end $$;

grant execute on function public.ot_return_repeats() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. "Complete return" for an Initial-QA rejection.
--
-- Deliberately a separate function from ot_complete_return (0036) rather than
-- an overload: that one takes p_repeat_id and asserts against the production
-- state machine, and PostgREST resolves overloads by argument name, so two
-- functions differing only in their first parameter name is exactly the shape
-- that produces "function not found" at the wrong call site. One button in the
-- UI, dispatched on the board's `kind`.
-- ---------------------------------------------------------------------------
create or replace function public.ot_complete_qa_return(
  p_damage_id uuid,
  p_note      text default null
)
returns public.damage_records
language plpgsql security definer set search_path = public as $$
declare
  v_factory    uuid := public.current_factory_id();
  v_all        boolean;
  v_damage     public.damage_records;
  v_created_by uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['order_taker','company_admin']);
  v_all := public.current_user_role() = 'company_admin';

  select d.* into v_damage
    from public.damage_records d
   where d.id = p_damage_id
     and d.factory_id = v_factory
     and d.stage_type = 'repeat_qa'
     and d.repeat_id is null;

  if v_damage.id is null then
    perform public.raise_not_found('Rejected piece not found.');
  end if;

  select created_by into v_created_by from public.orders where id = v_damage.order_id;
  if not v_all and v_created_by is distinct from auth.uid() then
    perform public.raise_not_found('Rejected piece not found.');
  end if;

  if v_damage.ot_return_confirmed_at is not null then
    raise exception 'This return has already been completed.' using errcode = '22023';
  end if;

  update public.damage_records
     set ot_return_confirmed_at = now(),
         ot_return_note = p_note
   where id = p_damage_id
  returning * into v_damage;

  return v_damage;
end $$;

grant execute on function public.ot_complete_qa_return(uuid, text) to authenticated;
