-- =============================================================================
-- Factory ERP — Floor Manager: "Ask for material".
--
-- BEHAVIOR CHANGE: until now, `material_issue_queue()` (0013) surfaced any job
-- card the moment it was confirmed — confirmation alone was sufficient. The
-- spec requires an explicit request step instead: nothing should appear in the
-- Store Manager's Material Requests until the Floor Manager presses "Ask for
-- material". This does NOT touch `fm_confirm_job_card`'s advance of every
-- repeat to 'ready_for_production' on confirmation — that stays exactly as is.
-- Only the queue's visibility gate changes, by adding one predicate.
-- =============================================================================

alter table public.job_cards
  add column if not exists material_requested_at timestamptz;

/** One-shot: a job card can only be asked for once its card is confirmed. */
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

-- ---------------------------------------------------------------------------
-- The gate: confirmed AND requested, not confirmed alone.
-- ---------------------------------------------------------------------------
create or replace function public.material_issue_queue()
returns table (
  job_card_id uuid,
  order_id    uuid,
  order_code  text,
  vendor_name text,
  confirmed_at timestamptz,
  colors      int,
  total_meters numeric
)
language sql stable security definer set search_path = public as $$
  select jc.id, o.id, o.order_code, v.name, jc.confirmed_at,
         (select count(*)::int from public.order_thread_requirements(o.id)),
         (select coalesce(sum(required_meters), 0) from public.order_thread_requirements(o.id))
  from public.job_cards jc
  join public.orders o on o.id = jc.order_id
  join public.vendors v on v.id = o.vendor_id
  where jc.factory_id = public.current_factory_id()
    and jc.status = 'confirmed'
    and jc.material_requested_at is not null
    and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id)
  order by jc.confirmed_at
$$;
