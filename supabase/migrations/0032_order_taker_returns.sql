-- =============================================================================
-- Factory ERP — Order Taker: Returns board
--
-- No new tables and no new state. The Returns board is a READ over Phase 6's
-- existing finishing data — `repeat_stage_history` (handed_off_at / returned_at
-- / partner_id), `repeats.current_status`, `order_stages` and the order-level
-- delivery columns. Nothing here writes, and nothing here is reachable by a role
-- that could act on the underlying rows anyway.
--
-- WHAT THE THREE BUCKETS MEAN (stated here because the screen must not invent
-- its own definitions):
--
--   active     — the repeat has been handed off at least once and has not yet
--                cleared its final stage: it is out at a partner, in transit,
--                or back and waiting on collection QA.
--   completed  — the repeat has come back AND passed collection QA for its last
--                stage, so it now sits at awaiting_final_qa or completed.
--   handover   — final delivery to the client.
--
-- The third bucket is ORDER-LEVEL on purpose. Phase 6 records delivery on the
-- order (`orders.delivered_at`, `delivery_photo_url`, `delivery_signature_url`)
-- via dp_complete_delivery, not per repeat — there is no per-repeat handover
-- row to read. Rather than approximate one by fanning the order's timestamp out
-- across its repeats, the board reports handover as orders, and carries the
-- repeat counts alongside so the two tabs still reconcile.
--
-- Scope: an order taker sees ONLY the orders they created. company_admin sees
-- the whole factory, since they own it.
-- =============================================================================

/**
 * Repeats in (or through) the finishing/return cycle, for orders the caller
 * created. One row per repeat, bucketed 'active' or 'completed'.
 *
 * A repeat with no handoff in its history is not on this board at all — it has
 * not entered the return cycle, and showing it as "active" would overstate what
 * the data says.
 */
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
  sla_breached   boolean
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
  rep as (
    select r.id, r.repeat_code, r.current_status, s.sheet_number, s.color_assignment,
           mine.id as oid, mine.order_code as ocode, mine.vendor_id as vid
      from public.repeats r
      join public.sheets s on s.id = r.sheet_id
      join mine on mine.id = s.order_id
     where r.factory_id = v_factory
  ),
  -- The most recent movement per repeat: the stage it is at (or last cleared),
  -- who holds it, and when it went out / came back.
  last_move as (
    select distinct on (h.repeat_id)
           h.repeat_id, h.order_stage_id, h.partner_id, h.handed_off_at, h.returned_at
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
  )
  select
    rep.id, rep.repeat_code, rep.oid, rep.ocode,
    coalesce(v.name, '—'),
    rep.sheet_number, rep.color_assignment,
    rep.current_status,
    case
      when rep.current_status in ('awaiting_final_qa','completed') then 'completed'
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
    )
  from rep
  join totals on totals.repeat_id = rep.id and totals.handoffs > 0
  left join last_move on last_move.repeat_id = rep.id
  left join public.order_stages st on st.id = last_move.order_stage_id
  left join public.finishing_partners fp on fp.id = last_move.partner_id
  left join public.vendors v on v.id = rep.vid
  where rep.current_status <> 'damaged'
  order by coalesce(last_move.returned_at, last_move.handed_off_at) desc nulls last,
           rep.repeat_code;
end $$;

/**
 * Final delivery handover, for orders the caller created. `ready` means every
 * repeat has cleared final QA and the delivery person can hand over; `delivered`
 * means dp_complete_delivery has already run and stamped the order.
 */
create or replace function public.ot_handover_orders()
returns table (
  order_id        uuid,
  order_code      text,
  vendor_name     text,
  status          text,
  bucket          text,
  total_repeats   int,
  ready_repeats   int,
  delivered_at    timestamptz,
  has_proof       boolean,
  has_signature   boolean,
  created_at      timestamptz
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
  select
    o.id, o.order_code, coalesce(v.name, '—'), o.status,
    case when o.delivered_at is not null or o.status = 'completed'
         then 'delivered' else 'ready' end,
    (select count(*)::int from public.repeats r
       join public.sheets s on s.id = r.sheet_id
      where s.order_id = o.id),
    (select count(*)::int from public.repeats r
       join public.sheets s on s.id = r.sheet_id
      where s.order_id = o.id
        and r.current_status in ('awaiting_final_qa','completed')),
    o.delivered_at,
    o.delivery_photo_url is not null,
    o.delivery_signature_url is not null,
    o.created_at
  from public.orders o
  left join public.vendors v on v.id = o.vendor_id
  where o.factory_id = v_factory
    and (v_all or o.created_by = auth.uid())
    and (o.status in ('ready_for_delivery','completed') or o.delivered_at is not null)
  order by coalesce(o.delivered_at, o.updated_at) desc;
end $$;

grant execute on function public.ot_return_repeats() to authenticated;
grant execute on function public.ot_handover_orders() to authenticated;
