-- =============================================================================
-- Factory ERP — Daily audit, replacing the weekly one.
--
-- The brief removes the weekly/monthly split: daily audits accumulating over
-- time ARE the weekly and monthly view, filtered by date. So there is one audit
-- per factory per day, and the history list is the report.
--
-- WHAT IS REUSED, NOT REBUILT
-- ---------------------------
-- `stock_audits` / `stock_audit_items` already exist and already carry
-- audit_date, the expected/actual pair and the stored variance. Phase 4's
-- comment on why the variance is STORED rather than derived applies unchanged:
-- the expected figure is a point-in-time snapshot and the signed-off variance
-- must not move when stock does. Nothing here re-litigates that; it adds the
-- once-a-day rule, the item-id link the four types need, and the walk.
--
-- `sm_submit_audit` (the colour-keyed weekly RPC) is deliberately left in place.
-- It still works through the thread_stock view, it is asserted by the tenancy
-- suite, and deleting a working function in the same migration that introduces
-- its replacement is how a rollback becomes impossible. The app stops calling
-- it; that is the whole change from the app's side.
--
-- MANDATORY, NOT BLOCKING
-- -----------------------
-- Flagged assumption (3): "daily audit is mandatory" is enforced as a visible
-- flag on the Audit tab, not as a gate on the store manager's other work.
-- Blocking material issue because nobody counted the sequins this morning would
-- stop production over a bookkeeping task, which is a bigger failure than the
-- one it prevents. `audit_today_state()` returns the flag; nothing consumes it
-- as a precondition.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

-- Colour alone no longer identifies an item, so the audit line points at the row
-- it counted. Nullable: every historic weekly line carries only color_code.
alter table public.stock_audit_items
  add column if not exists inventory_item_id uuid
    references public.inventory_items(id) on delete set null,
  add column if not exists item_type text,
  -- The brief's Correct/Incorrect marking, kept as its own fact. It is NOT the
  -- same as "variance = 0": a counter can confirm a figure is right, and that
  -- confirmation is worth recording distinctly from never having looked.
  add column if not exists marked_correct boolean;

update public.stock_audit_items sai
   set inventory_item_id = ii.id,
       item_type         = ii.item_type
  from public.inventory_items ii
 where ii.factory_id = sai.factory_id
   and ii.item_type = 'thread'
   and ii.color_code = sai.color_code
   and sai.inventory_item_id is null;

alter table public.stock_audits
  add column if not exists audit_type text not null default 'daily';

alter table public.stock_audits drop constraint if exists stock_audits_type_chk;
alter table public.stock_audits add constraint stock_audits_type_chk
  check (audit_type in ('daily','weekly'));

-- Historic rows were the weekly audit; labelling them 'daily' would be a lie in
-- the history list the brief asks for.
--
-- DERIVED, not dated. The obvious version tested `submitted_at < today`, which
-- is right the day this file is first applied and wrong every day after: re-run
-- it next week and it relabels last week's real daily audits as weekly.
--
-- `marked_correct` is only ever written by sm_submit_daily_audit, and that
-- function refuses an empty item list — so an audit with no marked item cannot
-- have come from the daily flow, whatever its date. That holds on every re-run.
update public.stock_audits sa
   set audit_type = 'weekly'
 where sa.audit_type = 'daily'
   and not exists (
     select 1 from public.stock_audit_items i
      where i.stock_audit_id = sa.id
        and i.marked_correct is not null
   );

/**
 * One daily audit per factory per day.
 *
 * Attempted as an index and enforced in the RPC either way. If a factory
 * already has two audits dated the same day — possible under the weekly flow,
 * which never had this rule — the index cannot be created, and failing the whole
 * migration over historic data would be the wrong trade. The RPC's own check is
 * the guarantee going forward; the index is defence in depth where the data
 * allows it.
 */
do $$
begin
  create unique index uq_daily_audit_per_day
    on public.stock_audits (factory_id, audit_date)
    where audit_type = 'daily';
exception when others then
  raise notice
    'Could not add uq_daily_audit_per_day (%). The once-a-day rule is still '
    'enforced in sm_submit_daily_audit; historic duplicate dates are why.',
    sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Has today's audit been done?
-- ---------------------------------------------------------------------------
create or replace function public.audit_today_state()
returns table (
  done         boolean,
  audit_id     uuid,
  audit_code   text,
  submitted_at timestamptz,
  item_count   int
)
language sql stable security definer set search_path = public as $$
  select (sa.id is not null),
         sa.id, sa.audit_code, sa.submitted_at,
         (select count(*)::int from public.stock_audit_items i where i.stock_audit_id = sa.id)
    from (select 1) _
    left join public.stock_audits sa
           on sa.factory_id = public.current_factory_id()
          and sa.audit_type = 'daily'
          and sa.audit_date = current_date
$$;

grant execute on function public.audit_today_state() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The walk — every item, with what the system believes
-- ---------------------------------------------------------------------------
/**
 * One row per inventory item for the counter to mark Correct or Incorrect.
 *
 * `expected_quantity` is read live at the moment the walk is opened. That is the
 * figure the counter is agreeing or disagreeing with, and it is re-read on
 * submission so a movement during the count cannot be silently overwritten.
 */
create or replace function public.audit_walk_items()
returns table (
  inventory_item_id uuid,
  item_type         text,
  color_code        text,
  color_name        text,
  expected_quantity numeric,
  unit              text,
  size_mm           int,
  sequin_type       text
)
language sql stable security definer set search_path = public as $$
  select ii.id, ii.item_type, ii.color_code, ii.color_name, ii.quantity, ii.unit,
         ii.size_mm, ii.sequin_type
    from public.inventory_items ii
   where ii.factory_id = public.current_factory_id()
   order by ii.item_type, ii.color_code
$$;

grant execute on function public.audit_walk_items() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Submit
-- ---------------------------------------------------------------------------
/**
 * Submit today's audit.
 *
 * p_items: [{ inventory_item_id, correct: bool, actual_quantity?: numeric }]
 *
 *   correct   -> confirmed, no movement, variance 0
 *   incorrect -> actual_quantity is required; the signed difference is written
 *                as an `audit_variance` movement and the item is set to the
 *                counted figure
 *
 * The variance goes through `log_inventory_movement` like every other stock
 * change, so the ledger still reconciles to the balance. Phase 4 named
 * audit_variance as the leakage signal; this is the same movement type, now for
 * all four item types rather than thread alone.
 */
create or replace function public.sm_submit_daily_audit(
  p_items jsonb,
  p_note  text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory   uuid := public.current_factory_id();
  v_audit     public.stock_audits;
  x           jsonb;
  v_item      public.inventory_items;
  v_actual    numeric(14,2);
  v_correct   boolean;
  v_delta     numeric(14,2);
  v_lines     int := 0;
  v_corrected int := 0;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'There is nothing to audit.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.stock_audits
     where factory_id = v_factory and audit_type = 'daily' and audit_date = current_date
  ) then
    raise exception 'Today''s audit has already been done.' using errcode = '22023';
  end if;

  insert into public.stock_audits
    (factory_id, audit_code, audit_date, audit_type, conducted_by, note)
  values
    (v_factory,
     public.make_code(v_factory, 'AUD', public.next_counter(v_factory, 'audit_seq')),
     current_date, 'daily', auth.uid(), p_note)
  returning * into v_audit;

  for x in select * from jsonb_array_elements(p_items)
  loop
    v_item    := public.assert_my_inventory_item((x->>'inventory_item_id')::uuid);
    v_correct := coalesce((x->>'correct')::boolean, false);

    if v_correct then
      -- Confirmed. The expected figure is re-read from v_item, not taken from
      -- the client, so a stale screen cannot quietly re-assert an old balance.
      v_actual := v_item.quantity;
    else
      if x->>'actual_quantity' is null then
        raise exception 'Enter the actual count for % before submitting.', v_item.color_code
          using errcode = '22023';
      end if;
      v_actual := (x->>'actual_quantity')::numeric;
      if v_actual < 0 then
        raise exception 'A count cannot be negative (%).', v_item.color_code
          using errcode = '22023';
      end if;
    end if;

    v_delta := v_actual - v_item.quantity;

    insert into public.stock_audit_items
      (factory_id, stock_audit_id, inventory_item_id, item_type, color_code,
       expected_meters, actual_meters, variance_meters, marked_correct)
    values
      (v_factory, v_audit.id, v_item.id, v_item.item_type, v_item.color_code,
       v_item.quantity, v_actual, v_delta, v_correct);

    if v_delta <> 0 then
      perform public.log_inventory_movement(
        v_item.id, v_delta, 'audit_variance', 'stock_audit', v_audit.id,
        'Daily audit correction on ' || to_char(current_date, 'DD Mon YYYY'));
      v_corrected := v_corrected + 1;
    end if;

    v_lines := v_lines + 1;
  end loop;

  return jsonb_build_object(
    'audit_id', v_audit.id,
    'audit_code', v_audit.audit_code,
    'items', v_lines,
    'corrected', v_corrected
  );
end $$;

grant execute on function public.sm_submit_daily_audit(jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. History and detail
-- ---------------------------------------------------------------------------
/** Past audits, newest first — "Audit of 23 December" in the brief's words. */
create or replace function public.audit_history(p_limit int default 60)
returns table (
  id           uuid,
  audit_code   text,
  audit_date   date,
  audit_type   text,
  conducted_by text,
  item_count   int,
  corrected    int,
  submitted_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select sa.id, sa.audit_code, sa.audit_date, sa.audit_type, p.display_name,
         (select count(*)::int from public.stock_audit_items i
           where i.stock_audit_id = sa.id),
         (select count(*)::int from public.stock_audit_items i
           where i.stock_audit_id = sa.id and i.variance_meters <> 0),
         sa.submitted_at
    from public.stock_audits sa
    left join public.profiles p on p.id = sa.conducted_by
   where sa.factory_id = public.current_factory_id()
   order by sa.audit_date desc, sa.submitted_at desc
   limit greatest(coalesce(p_limit, 60), 1)
$$;

grant execute on function public.audit_history(int) to authenticated;

/** System count vs actual count per item, and what was corrected. */
create or replace function public.audit_detail(p_audit_id uuid)
returns table (
  color_code        text,
  color_name        text,
  item_type         text,
  unit              text,
  expected_quantity numeric,
  actual_quantity   numeric,
  variance          numeric,
  marked_correct    boolean
)
language sql stable security definer set search_path = public as $$
  select sai.color_code, ii.color_name,
         coalesce(sai.item_type, 'thread'),
         coalesce(ii.unit, 'm'),
         sai.expected_meters, sai.actual_meters, sai.variance_meters,
         sai.marked_correct
    from public.stock_audit_items sai
    join public.stock_audits sa on sa.id = sai.stock_audit_id
    left join public.inventory_items ii on ii.id = sai.inventory_item_id
   where sa.factory_id = public.current_factory_id()
     and sa.id = p_audit_id
   order by coalesce(sai.item_type,'thread'), sai.color_code
$$;

grant execute on function public.audit_detail(uuid) to authenticated;
