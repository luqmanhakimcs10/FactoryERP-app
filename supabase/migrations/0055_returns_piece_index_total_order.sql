-- =============================================================================
-- Factory ERP — Returns board: make the piece number deterministic.
--
-- 0054 numbers each sheet's pieces by ordering its slots (coded repeats +
-- repeat_qa rejections) on `created_at` alone. That is not a total order on
-- this data: `qa_generate_repeats` and `fm_confirm_job_card` code a sheet's
-- repeats in ONE statement, so they all carry the same `created_at`. Measured
-- on the live project, 14 of 22 multi-repeat sheets have such a tie — and with
-- a tie the row_number() falls back to whatever order the scan produced, so
-- "piece 2 of 3" could point at a different piece on two successive loads.
--
-- The fix is a total ordering that mirrors what the QA screen itself does
-- (`piecesForSheet` in OrderQaScreen.tsx): resolved pieces in resolution order,
-- passed before rejected within the same instant, and repeats among themselves
-- in repeat_number order. Concretely: created_at, then repeats before damages,
-- then repeat_number, then id as the final deterministic tiebreak.
--
-- Body-only change at the same signature as 0054, so `check:migrations` cannot
-- tell them apart — `npm run walk:lifecycle` is what proves the numbering.
-- =============================================================================

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
  --
  -- `slot_rank` and `slot_seq` exist purely to make the ordering total: see the
  -- header for why created_at alone is not.
  slots as (
    select r.sheet_id, 'repeat'::text as slot_kind, r.id as slot_id, r.created_at,
           0 as slot_rank, r.repeat_number as slot_seq
      from public.repeats r
     where r.factory_id = v_factory
    union all
    select d.sheet_id, 'damage'::text, d.id, d.created_at,
           1, null::int
      from public.damage_records d
     where d.factory_id = v_factory
       and d.stage_type = 'repeat_qa'
       and d.repeat_id is null
       and d.sheet_id is not null
  ),
  slot_index as (
    select slot_kind, slot_id, sheet_id,
           row_number() over (
             partition by sheet_id
             order by created_at, slot_rank, slot_seq nulls last, slot_id
           )::int as piece_index
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

  -- ---- Initial-QA rejection side (0054) ----
  select
    null::uuid,
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
