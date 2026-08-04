-- =============================================================================
-- Factory ERP — Phase 8 completion: partner earning postings.
--
-- Phase 6 recorded handoffs/returns but never realized the partner's earning;
-- Phase 7 wrote only damage_charge and payment rows to partner_ledger. The Phase 8
-- partner dashboard and the per-order finishing cost in reports both read
-- entry_type = 'earning' rows, which nothing produced — so they would have shown
-- a permanent zero.
--
-- This migration closes that loop: a returned stage that passes collection QA
-- posts the earning (partner rate x quantity) once per repeat + stage.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. post_partner_earning
--    Resolves the partner from the returned history row (falling back to the
--    stage's assigned partner), computes amount = rate x quantity, and inserts
--    a single 'earning' ledger row. Safe to call from a transition function:
--    returns null (never raises) when there is nothing to post.
-- ---------------------------------------------------------------------------
create or replace function public.post_partner_earning(
  p_repeat_id      uuid,
  p_order_stage_id uuid
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_factory      uuid := public.current_factory_id();
  v_partner      uuid;
  v_rate         numeric(12,4);
  v_basis        text;
  v_qty          numeric(14,2);
  v_amount       numeric(14,2);
  v_period       text := public.current_payroll_period();
  v_id           uuid;
begin
  -- Guard: the stage must belong to this repeat's order, and we only realize
  -- earnings for outsourced stages actually carried by a partner.
  select coalesce(rsh.partner_id, st.partner_id), fp.rate, fp.rate_basis, sh.stitch_count
    into v_partner, v_rate, v_basis, v_qty
    from public.repeats r
    join public.sheets sh on sh.id = r.sheet_id
    join public.order_stages st on st.id = p_order_stage_id
    left join public.repeat_stage_history rsh
      on rsh.repeat_id = p_repeat_id
     and rsh.order_stage_id = p_order_stage_id
     and rsh.returned_at is not null
    left join public.finishing_partners fp
      on fp.id = coalesce(rsh.partner_id, st.partner_id)
     and fp.deleted_at is null
   where r.id = p_repeat_id
     and r.factory_id = v_factory
     and st.order_id = sh.order_id
   order by rsh.created_at desc nulls last
   limit 1;

  if v_partner is null or v_rate is null or v_rate <= 0 then
    return null; -- in-house stage or unrated partner: nothing to post
  end if;

  -- per_stitch partners earn on the sheet's stitch count (each repeat carries
  -- the same design); per_repeat partners earn a flat rate per repeat.
  if v_basis = 'per_stitch' then
    v_amount := round(v_rate * coalesce(v_qty, 0), 2);
  else
    v_amount := round(v_rate, 2);
  end if;

  if v_amount <= 0 then
    return null;
  end if;

  -- Exactly one earning per repeat + stage. A repeat reworked through the same
  -- stage must not pay the partner twice for the same unit of work.
  if exists (
    select 1 from public.partner_ledger pl
     where pl.repeat_id = p_repeat_id
       and pl.order_stage_id = p_order_stage_id
       and pl.entry_type = 'earning'
  ) then
    return null;
  end if;

  insert into public.partner_ledger
    (factory_id, partner_id, entry_type, amount, period,
     repeat_id, order_stage_id, created_by)
  values
    (v_factory, v_partner, 'earning', v_amount, v_period,
     p_repeat_id, p_order_stage_id, auth.uid())
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 2. qa_collection_pass — realize the earning when a returned stage passes.
--    Recreated to add the post; everything else is unchanged from 0020.
-- ---------------------------------------------------------------------------
create or replace function public.qa_collection_pass(p_repeat_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.repeats;
  sh public.sheets;
  o public.orders;
  v_last_stage public.order_stages;
  v_next_stage public.order_stages;
  v_total_stages int;
  v_completed_repeats int;
  v_total_repeats int;
  v_new_status text;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','floor_manager','company_admin']);

  select * into r from public.repeats where id = p_repeat_id and factory_id = public.current_factory_id();
  if not found then perform public.raise_not_found('Repeat not found.'); end if;

  select * into sh from public.sheets where id = r.sheet_id;
  select * into o from public.orders where id = sh.order_id;

  -- Find last completed stage from history
  select st.* into v_last_stage
  from public.repeat_stage_history rsh
  join public.order_stages st on st.id = rsh.order_stage_id
  where rsh.repeat_id = p_repeat_id
    and rsh.returned_at is not null
  order by rsh.returned_at desc
  limit 1;

  -- Check next stage in sequence
  select * into v_next_stage
  from public.order_stages
  where order_id = o.id
    and sequence > coalesce(v_last_stage.sequence, 0)
  order by sequence asc
  limit 1;

  if v_next_stage.id is not null then
    -- More stages remain -> ready for next handoff/production
    v_new_status := 'ready_for_production';
  else
    -- All stages done -> ready for final QA
    v_new_status := 'awaiting_final_qa';
  end if;

  update public.repeats
     set current_status = v_new_status,
         updated_at = now()
   where id = p_repeat_id;

  -- Log QA pass event
  insert into public.repeat_stage_history (
    factory_id, repeat_id, order_stage_id, status, actor_user_id, note
  ) values (
    public.current_factory_id(), p_repeat_id, v_last_stage.id, v_new_status, auth.uid(), 'Collection QA passed'
  );

  -- Phase 8: realize the finishing partner's earning for the passed stage.
  if v_last_stage.id is not null then
    perform public.post_partner_earning(p_repeat_id, v_last_stage.id);
  end if;

  -- If all repeats for the order are in awaiting_final_qa / completed, update order status
  select count(*) into v_total_repeats from public.repeats r2 join public.sheets s2 on s2.id = r2.sheet_id where s2.order_id = o.id;
  select count(*) into v_completed_repeats from public.repeats r2 join public.sheets s2 on s2.id = r2.sheet_id where s2.order_id = o.id and r2.current_status in ('awaiting_final_qa', 'completed');

  if v_completed_repeats = v_total_repeats then
    update public.orders set status = 'ready_for_delivery', updated_at = now() where id = o.id;
  end if;

  return jsonb_build_object(
    'repeat_id', p_repeat_id,
    'next_status', v_new_status
  );
end $$;

-- Grants
grant execute on function public.post_partner_earning(uuid,uuid) to authenticated;
