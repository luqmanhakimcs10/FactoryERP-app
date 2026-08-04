-- =============================================================================
-- Factory ERP — Order Taker: "Complete return"
--
-- The Returns board (0032) was deliberately read-only: the order taker has no
-- write path to any table behind it, because every real state transition
-- (handoff, return, collection QA) belongs to delivery/QA/floor-manager roles.
-- This adds exactly one narrow write on top of that, for a physical event only
-- the order taker witnesses: the piece has actually gone back to the vendor.
--
-- This must NOT touch `repeats.current_status` — that column is the
-- denormalized cache of the production/finishing state machine (see 0007's
-- header), and a rejected piece can be sitting anywhere in that machine
-- (handed_off, awaiting_collection_qa, ...) when the order taker completes the
-- physical handback. Forcing current_status here would desync it from whatever
-- dp_confirm_return / qa_collection_pass later expects to find. Instead this
-- adds one boolean-shaped timestamp column that only ever moves a repeat from
-- the "active" to the "completed" bucket on the order taker's own board.
-- =============================================================================

alter table public.repeats
  add column if not exists ot_return_confirmed_at timestamptz;

/**
 * Mark a returned repeat's physical handback to the vendor as done. Only the
 * order taker who created the order (or company_admin) may call this, and
 * only on a repeat that is genuinely in the "active" return bucket.
 */
create or replace function public.ot_complete_return(
  p_repeat_id uuid,
  p_note      text default null
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_factory    uuid := public.current_factory_id();
  v_all        boolean;
  v_repeat     public.repeats;
  v_order_id   uuid;
  v_created_by uuid;
  v_handoffs   int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['order_taker','company_admin']);
  v_all := public.current_user_role() = 'company_admin';

  -- A record variable cannot share an INTO list with another target, so the
  -- repeat and its order_id (via the sheet) are fetched in two steps.
  select r.* into v_repeat
    from public.repeats r
   where r.id = p_repeat_id
     and r.factory_id = v_factory;

  if v_repeat.id is null then
    perform public.raise_not_found('Repeat not found.');
  end if;

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  select created_by into v_created_by from public.orders where id = v_order_id;
  if not v_all and v_created_by is distinct from auth.uid() then
    perform public.raise_not_found('Repeat not found.');
  end if;

  if v_repeat.ot_return_confirmed_at is not null
     or v_repeat.current_status in ('awaiting_final_qa', 'completed', 'damaged') then
    raise exception 'This repeat is not an active return.' using errcode = '22023';
  end if;

  select count(*) into v_handoffs
    from public.repeat_stage_history
   where repeat_id = p_repeat_id
     and handed_off_at is not null;

  if v_handoffs = 0 then
    raise exception 'This repeat has not been handed off yet.' using errcode = '22023';
  end if;

  -- Audit trail only — deliberately not routed through log_repeat_stage,
  -- which would also overwrite current_status (see header comment above).
  insert into public.repeat_stage_history
    (factory_id, repeat_id, status, actor_user_id, note)
  values
    (v_factory, p_repeat_id, 'return_confirmed_by_order_taker', auth.uid(), p_note);

  update public.repeats
     set ot_return_confirmed_at = now()
   where id = p_repeat_id
  returning * into v_repeat;

  return v_repeat;
end $$;

grant execute on function public.ot_complete_return(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Surface the new column and fold it into the bucket rule: a repeat the order
-- taker has confirmed is "completed" on this board even if its production
-- current_status hasn't reached awaiting_final_qa/completed yet.
--
-- Adding a column to a RETURNS TABLE(...) signature is a return-type change,
-- which CREATE OR REPLACE refuses ("cannot change return type of existing
-- function") — the old signature must be dropped first.
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
  ot_return_confirmed_at timestamptz
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
    select r.id, r.repeat_code, r.current_status, r.ot_return_confirmed_at,
           s.sheet_number, s.color_assignment,
           mine.id as oid, mine.order_code as ocode, mine.vendor_id as vid
      from public.repeats r
      join public.sheets s on s.id = r.sheet_id
      join mine on mine.id = s.order_id
     where r.factory_id = v_factory
  ),
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
    rep.ot_return_confirmed_at
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
