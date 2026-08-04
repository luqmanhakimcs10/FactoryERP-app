-- =============================================================================
-- Factory ERP — Fix 0: an order cannot reach production with no coded repeats.
--
-- THE EVIDENCE
-- ------------
-- ALP-00084 (Alpha): 1 sheet, 1 piece, that piece rejected at Initial QA, ZERO
-- rows in `repeats` — and yet `status = 'in_production'`. Its Stage Tracking
-- screen reads "No repeats coded yet", because there is genuinely nothing to
-- track. Every later feature in the stage handover loop operates on repeats, so
-- an order in this state is inert: no stage can start, no QA can run, no
-- handover can happen, and nothing ever tells anyone why.
--
-- THE ROOT CAUSE (traced, not guessed)
-- ------------------------------------
-- Three functions write `awaiting_job_card`:
--   qa_generate_repeats (0008)  — creates a repeat per slot first. Safe.
--   fm_request_changes  (0008)  — the order already has repeats. Safe.
--   qa_complete_repeat_qa (0034) — THE HOLE. It counted a slot as "resolved" if
--     it had EITHER a coded repeat OR a rejection, so an order whose every piece
--     was rejected passed the check with zero repeats and advanced.
--
-- That hole is already closed (0059 added a per-sheet `coded = 0` refusal).
-- ALP-00084 predates the fix.
--
-- WHY THIS MIGRATION EXISTS ANYWAY
-- --------------------------------
-- Closing the one known entry point is not the same as guaranteeing the
-- invariant. `fm_start_production` — the last gate before an order becomes
-- everyone else's problem — never checked that there was anything to produce.
-- It looped over repeats, advanced however many it found (possibly none), and
-- set `in_production` regardless. So this adds the guard at the gate itself,
-- where it holds no matter which upstream path is taken, including paths added
-- later. Defence in depth, deliberately duplicating 0059's check rather than
-- trusting it.
--
-- A SECOND, QUIETER BUG IS FIXED HERE TOO
-- ---------------------------------------
-- `fm_start_production` also silently tolerated advancing ZERO repeats when the
-- order did have repeats but none were in a startable state. That is the
-- "stranded repeat" condition: a repeat left at `ready_for_production` with
-- `current_stage_index = 0` after its order has already moved on can never
-- enter the loop, because this is the only function that puts repeats into it
-- and it only runs at `machine_selection_pending`. Now the function refuses
-- rather than pretending it started something.
-- =============================================================================

create or replace function public.fm_start_production(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order    public.orders;
  v_first    uuid;
  r          record;
  v_moved    int := 0;
  v_repeats  int;
  v_startable int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'machine_selection_pending' then
    raise exception 'This order is not awaiting production start (status: %).', v_order.status
      using errcode = '22023';
  end if;

  -- ---- Fix 0: there must be something to produce. ----
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
  if not exists (
    select 1 from public.shifts
     where machine_id = v_order.assigned_machine_id and status = 'open'
  ) then
    raise exception 'The assigned machine does not currently have an active shift.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.order_stages where order_id = p_order_id) then
    raise exception 'This order has no stages configured on its job card.' using errcode = '22023';
  end if;

  -- Repeats that can actually enter the loop. Refusing here is what stops a
  -- repeat being stranded outside it forever (see the header).
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
-- Fail EARLIER too, with a message that names the real problem.
--
-- Without this, an all-rejected order still gets a stage sequence and a job
-- card built for it, and only trips at Start Production — three steps of the
-- Floor Manager's work after the point where it was already doomed.
-- ---------------------------------------------------------------------------
create or replace function public.assert_order_has_repeats(p_order_id uuid)
returns int
language plpgsql stable security definer set search_path = public as $$
declare v_n int;
begin
  select count(*) into v_n
    from public.repeats rp
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id;

  if v_n = 0 then
    raise exception
      'This order has no coded repeats. Initial QA has to pass at least one piece before a job card can be built for it.'
      using errcode = '22023';
  end if;
  return v_n;
end $$;

create or replace function public.fm_set_stage_sequence(
  p_order_id uuid,
  p_stages   jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  st        jsonb;
  i         int := 0;
  v_partner uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status not in ('awaiting_job_card','job_card_shared') then
    raise exception 'The stage sequence can only be set before the job card is confirmed (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_stages is null or jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) = 0 then
    raise exception 'Pick at least one stage.' using errcode = '22023';
  end if;

  -- Fix 0, upstream copy.
  perform public.assert_order_has_repeats(p_order_id);

  -- Safe to clear: history rows keep their own copy via ON DELETE SET NULL, so
  -- no repeat's audit trail is lost when the sequence is revised.
  delete from public.order_stages where order_id = p_order_id;

  for st in select * from jsonb_array_elements(p_stages)
  loop
    i := i + 1;
    v_partner := nullif(st->>'partner_id', '')::uuid;

    if v_partner is not null and not exists (
      select 1 from public.finishing_partners
       where id = v_partner and factory_id = v_order.factory_id and deleted_at is null
    ) then
      perform public.raise_not_found('Finishing partner not found.');
    end if;

    insert into public.order_stages
      (factory_id, order_id, sequence, stage_type, is_outsourced, partner_id,
       handler_user_id, sla_hours)
    values
      (v_order.factory_id, p_order_id, i, st->>'stage_type',
       coalesce((st->>'is_outsourced')::boolean, false),
       v_partner,
       nullif(st->>'handler_user_id','')::uuid,
       coalesce((st->>'sla_hours')::int, 24));
  end loop;

  return jsonb_build_object('order_id', p_order_id, 'stages', i);
end $$;

grant execute on function public.assert_order_has_repeats(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- REPAIR the orders that already got through.
--
-- Sent back to `awaiting_coding`, which is the only status that honestly
-- describes them: no piece has ever been passed, so Initial QA's work is not
-- actually finished. Their rejected pieces are put into the 0059 return loop at
-- `awaiting_return` so the Order Taker picks them up, exactly as a rejection
-- made today would.
--
-- Deliberately narrow: ONLY orders with zero repeats. An order with even one
-- coded repeat is legitimately in production and is not touched. Job cards and
-- stage sequences are left alone — they are still valid once pieces exist, and
-- destroying the Floor Manager's stage choices would be a second bug.
-- ---------------------------------------------------------------------------
do $$
declare
  r         record;
  v_healed  int := 0;
begin
  for r in
    select o.id, o.order_code
      from public.orders o
     where o.status in ('awaiting_job_card','job_card_shared','job_card_confirmed',
                        'machine_selection_pending','in_production','in_finishing',
                        'awaiting_final_qa','ready_for_delivery')
       and not exists (
         select 1 from public.repeats rp
           join public.sheets s on s.id = rp.sheet_id
          where s.order_id = o.id
       )
  loop
    update public.orders
       set status = 'awaiting_coding', assigned_machine_id = null
     where id = r.id;

    update public.damage_records
       set recheck_state = 'awaiting_return'
     where order_id = r.id
       and stage_type = 'repeat_qa'
       and repeat_id is null
       and coalesce(recheck_state, 'written_off') = 'written_off';

    raise notice 'Healed % — sent back to awaiting_coding (no coded repeats).', r.order_code;
    v_healed := v_healed + 1;
  end loop;

  raise notice 'Fix 0 repair: % order(s) healed.', v_healed;
end $$;
