-- =============================================================================
-- Factory ERP — Two open defects closed: stranded repeats, and the write-off
-- deadlock.
--
-- =============================================================================
-- A. STRANDED REPEATS — ROOT CAUSE, TRACED
-- =============================================================================
-- Nine repeats sat at `ready_for_production` / `current_stage_index = 0` on
-- orders already `in_finishing`. Nothing in the app could move them: the ONLY
-- function that puts repeats into the stage loop is `fm_start_production`, and
-- it only runs at `machine_selection_pending`, which those orders had left.
--
-- The history of a sibling repeat shows exactly how:
--
--   ALP-00050-S1-R003:  coded -> ready_for_production -> handed_off (no note)
--
-- That `handed_off` with no note is Phase 6's `dp_confirm_handoff` (0020). It
-- writes `handed_off` DIRECTLY from `ready_for_production`, skipping
-- in_progress / stage_qa entirely, and — the damaging part — it also does:
--
--   update orders set status = 'in_production' | 'in_finishing' ...
--
-- So one repeat being handed off through the legacy path dragged the whole
-- ORDER out of `machine_selection_pending`, and every sibling that had not yet
-- been touched became unreachable. `fm_start_production` was then refused for
-- the rest of that order's life.
--
-- THE REAL BUG IS TWO PIPELINES. 0056 replaced Phase 6's handoff/collection
-- mechanism with the full stage loop, but the old RPCs were left callable
-- alongside it. Two ways to move the same rows, disagreeing about what the
-- statuses mean, is what produced the stranding — patching the symptom would
-- leave the mechanism in place. So this migration RETIRES the legacy pipeline
-- and then repairs the rows it damaged.
--
-- The screens that called these were already orphaned when the Delivery Person
-- was cut down to one tab; they are deleted alongside this migration.
--
-- =============================================================================
-- B. THE WRITE-OFF DEADLOCK
-- =============================================================================
-- 0059 gave a rejected piece a return loop but nothing ever set `written_off`,
-- so a vendor who never sends a piece back left the order at `awaiting_coding`
-- forever. `qa_write_off_piece` closes that slot.
--
-- Writing off is NOT enough on its own, and this is worth being explicit about:
-- if EVERY piece on an order is written off, the order has nothing to produce
-- and `qa_complete_repeat_qa` still refuses it (correctly — Fix 0's invariant).
-- The honest end state for such an order is CANCELLED, not "pushed into
-- production empty", so `fm_cancel_order` exists to say so. Without it the
-- write-off would only relocate the deadlock.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A1. Retire the legacy Phase 6 handoff/collection pipeline.
--
-- Dropped rather than left raising: a function that exists but always fails is
-- a trap for the next person reading the schema. Same treatment `fm_start_stage`
-- got in 0056, and for the same reason.
-- ---------------------------------------------------------------------------
drop function if exists public.dp_confirm_handoff(uuid, uuid, text);
drop function if exists public.dp_handoff_queue();
drop function if exists public.dp_confirm_return(uuid, text, boolean, text, text, text);
drop function if exists public.dp_return_queue();
drop function if exists public.qa_collection_queue();
drop function if exists public.qa_collection_pass(uuid);
drop function if exists public.qa_collection_damage(uuid, text, text, text);

-- `assert_stage_access` existed only to gate those functions. 0056's loop uses
-- role checks plus `assert_my_repeat`, so nothing calls it any more.
drop function if exists public.assert_stage_access(uuid);

-- ---------------------------------------------------------------------------
-- A2. Bring stranded repeats into the loop.
--
-- Self-service for the Floor Manager rather than a one-off script: with the
-- legacy path gone this should never recur, but "should never" is not a reason
-- to leave the only remedy in a migration nobody can run twice.
--
-- Deliberately narrow — it will not touch a repeat that is legitimately mid-loop
-- or finished, only ones that provably cannot move.
-- ---------------------------------------------------------------------------
create or replace function public.fm_adopt_stranded_repeats(p_order_id uuid)
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

  if v_order.status not in ('in_production', 'in_finishing') then
    raise exception 'Only an order already in production can adopt stranded repeats (status: %).',
      v_order.status using errcode = '22023';
  end if;

  select id into v_first from public.order_stages
   where order_id = p_order_id order by sequence limit 1;

  if v_first is null then
    raise exception 'This order has no stages configured.' using errcode = '22023';
  end if;

  for r in
    select rp.id, rp.repeat_code
      from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where s.order_id = p_order_id
       -- The stranded signature, and nothing else.
       and rp.current_status = 'ready_for_production'
       and rp.current_stage_index = 0
  loop
    update public.repeats set current_stage_index = 1 where id = r.id;
    perform public.log_repeat_stage(r.id, 'in_progress', v_first, null,
      'Adopted into the stage loop — was stranded outside it');
    v_moved := v_moved + 1;
  end loop;

  return jsonb_build_object('order_id', p_order_id, 'repeats_adopted', v_moved);
end $$;

/** Orders carrying repeats that can never move. Backs the Floor Manager's prompt. */
create or replace function public.fm_stranded_repeat_orders()
returns table (
  order_id     uuid,
  order_code   text,
  order_status text,
  stranded     int
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  return query
  select o.id, o.order_code, o.status,
         count(*) filter (
           where rp.current_status = 'ready_for_production' and rp.current_stage_index = 0
         )::int
    from public.orders o
    join public.sheets s on s.order_id = o.id
    join public.repeats rp on rp.sheet_id = s.id
   where o.factory_id = public.current_factory_id()
     and o.status in ('in_production', 'in_finishing')
   group by o.id, o.order_code, o.status
  having count(*) filter (
           where rp.current_status = 'ready_for_production' and rp.current_stage_index = 0
         ) > 0
   order by o.created_at;
end $$;

-- ---------------------------------------------------------------------------
-- A3. Repair the nine that already exist.
--
-- `log_repeat_stage` cannot be used here. It resolves the caller's factory from
-- the JWT (`current_factory_id()`) and refuses when the repeat's factory does
-- not match — and a migration running as `postgres` has no JWT at all, so every
-- call would raise "Repeat not found." That guard is right for application
-- callers and should not be weakened for the convenience of a one-off repair.
--
-- So this writes the same TWO rows the primitive would, in the same statement
-- pair and the same transaction: the append-only history row first, then the
-- denormalised cache. The invariant that makes history the source of truth is
-- preserved; only the JWT-derived plumbing is bypassed.
-- ---------------------------------------------------------------------------
do $$
declare
  r       record;
  v_first uuid;
  v_total int := 0;
begin
  for r in
    select rp.id, rp.repeat_code, rp.factory_id, s.order_id
      from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
      join public.orders o on o.id = s.order_id
     where rp.current_status = 'ready_for_production'
       and rp.current_stage_index = 0
       and o.status in ('in_production', 'in_finishing')
  loop
    select id into v_first from public.order_stages
     where order_id = r.order_id order by sequence limit 1;

    if v_first is null then
      raise notice 'Skipped % — its order has no stages.', r.repeat_code;
      continue;
    end if;

    -- 1. Source of truth.
    insert into public.repeat_stage_history
      (factory_id, repeat_id, order_stage_id, status, actor_user_id, note)
    values
      (r.factory_id, r.id, v_first, 'in_progress', null,
       'Adopted into the stage loop (0063) — stranded by the retired Phase 6 handoff path');

    -- 2. Denormalised cache, same transaction.
    update public.repeats
       set current_status = 'in_progress',
           current_stage_index = 1,
           updated_at = now()
     where id = r.id;

    v_total := v_total + 1;
  end loop;

  raise notice 'Stranded-repeat repair: % repeat(s) adopted into the loop.', v_total;
end $$;

-- ---------------------------------------------------------------------------
-- Audit columns for the two decisions below.
--
-- Neither can be recorded in `repeat_stage_history`: that table's `repeat_id`
-- is NOT NULL, and the whole point of a written-off piece is that no repeat was
-- ever coded for it. An order-level cancellation has no single repeat either.
-- So the evidence lives on the row the decision was actually about.
-- ---------------------------------------------------------------------------
alter table public.damage_records
  add column if not exists written_off_at timestamptz,
  add column if not exists written_off_by uuid references public.profiles(id) on delete set null,
  add column if not exists write_off_reason text;

alter table public.orders
  add column if not exists cancelled_at    timestamptz,
  add column if not exists cancelled_by    uuid references public.profiles(id) on delete set null,
  add column if not exists cancel_reason   text;

-- ---------------------------------------------------------------------------
-- B1. Write off a piece the vendor is never going to return.
--
-- The slot closes with NO repeat behind it, so the sheet still accounts for its
-- full `repeats_count` and `qa_complete_repeat_qa` stops waiting on it. The
-- damage record stays exactly as it was — vendor-accountable, photographed,
-- reasoned — because writing off is an admission that the piece is gone, not a
-- retraction of who lost it.
-- ---------------------------------------------------------------------------
create or replace function public.qa_write_off_piece(
  p_damage_id uuid,
  p_note      text default null
)
returns public.damage_records
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_damage  public.damage_records;
  v_order   public.orders;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  select d.* into v_damage
    from public.damage_records d
   where d.id = p_damage_id
     and d.factory_id = v_factory
     and d.stage_type = 'repeat_qa'
     and d.repeat_id is null;

  if v_damage.id is null then
    perform public.raise_not_found('Rejected piece not found.');
  end if;

  if coalesce(v_damage.recheck_state, 'awaiting_return')
       not in ('awaiting_return', 'awaiting_recheck') then
    raise exception 'This piece is not in the return loop (state: %).',
      coalesce(v_damage.recheck_state, 'awaiting_return') using errcode = '22023';
  end if;

  v_order := public.assert_my_order(v_damage.order_id);
  if v_order.status <> 'awaiting_coding' then
    raise exception 'Pieces can only be written off while the order is at repeat QA (status: %).',
      v_order.status using errcode = '22023';
  end if;

  -- Written off is a decision someone made; record who and why on the piece.
  update public.damage_records
     set recheck_state    = 'written_off',
         written_off_at   = now(),
         written_off_by   = auth.uid(),
         write_off_reason = coalesce(nullif(trim(p_note), ''),
                                     'Never returned by the vendor')
   where id = p_damage_id
  returning * into v_damage;

  return v_damage;
end $$;

-- ---------------------------------------------------------------------------
-- B2. Cancel an order that has nothing left to produce.
--
-- The other half of the escape hatch. Writing off every piece leaves an order
-- that can never legitimately reach production; without this it would simply be
-- deadlocked at `awaiting_coding` instead of at the return loop.
--
-- Guarded so it cannot be used to erase real work: refused once ANY piece has
-- completed, or once the order has been invoiced. Floor Manager and company
-- admin only — the Order Taker's board is read-only after submission.
-- ---------------------------------------------------------------------------
create or replace function public.fm_cancel_order(
  p_order_id uuid,
  p_reason   text
)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order     public.orders;
  v_completed int;
  v_invoiced  int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager', 'company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to cancel an order.' using errcode = '22023';
  end if;
  if v_order.status in ('cancelled', 'completed') then
    raise exception 'This order is already %.', v_order.status using errcode = '22023';
  end if;

  select count(*) into v_completed
    from public.repeats rp
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id and rp.current_status = 'completed';

  if v_completed > 0 then
    raise exception
      'This order has % finished piece(s) — it cannot be cancelled. Deliver and invoice what was produced.',
      v_completed using errcode = '22023';
  end if;

  select count(*) into v_invoiced
    from public.invoices where order_id = p_order_id and status <> 'cancelled';

  if v_invoiced > 0 then
    raise exception 'This order has been invoiced and cannot be cancelled.' using errcode = '22023';
  end if;

  update public.orders
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancelled_by  = auth.uid(),
         cancel_reason = trim(p_reason),
         updated_at    = now()
   where id = p_order_id
  returning * into v_order;

  return v_order;
end $$;

grant execute on function public.fm_adopt_stranded_repeats(uuid)   to authenticated;
grant execute on function public.fm_stranded_repeat_orders()       to authenticated;
grant execute on function public.qa_write_off_piece(uuid, text)    to authenticated;
grant execute on function public.fm_cancel_order(uuid, text)       to authenticated;
