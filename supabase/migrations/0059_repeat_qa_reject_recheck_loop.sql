-- =============================================================================
-- Factory ERP — A rejected piece must come BACK through QA before the job card.
--
-- THE BUG THIS FIXES
-- ------------------
-- 0034 treated a piece as "resolved" once it had EITHER been coded as a repeat
-- OR rejected. So an order whose every piece was rejected still counted as
-- fully resolved, "Continue to job card" lit up, and the order advanced to
-- production with zero usable pieces. A rejection is not an outcome — it is the
-- start of a round trip.
--
-- THE LOOP THIS INTRODUCES (per rejected piece)
-- --------------------------------------------
--   awaiting_return   QA rejected it. It is with the Order Taker, who has to
--                     physically hand it back to the vendor. BLOCKS the job card.
--   awaiting_recheck  The Order Taker completed the return (photo and all, per
--                     0057), so the piece is back. QA must inspect it again.
--                     BLOCKS the job card. The order is still `awaiting_coding`,
--                     so it is still sitting in QA's own queue — no new status
--                     and no notification table needed for it to reappear.
--   passed            QA re-inspected and passed it; a real repeat was coded for
--                     the slot, exactly as a first-time pass would.
--   superseded        QA re-inspected and rejected it AGAIN. A fresh damage row
--                     takes over the slot at `awaiting_return`, so the loop runs
--                     again. The old row stays for the audit trail but no longer
--                     occupies the slot.
--   written_off       The slot is closed with no repeat. NOTHING SETS THIS YET —
--                     see the note at the bottom of this file.
--
-- WHY A STATE COLUMN AND NOT JUST `ot_return_confirmed_at`
-- -------------------------------------------------------
-- That timestamp answers "did the Order Taker hand it back?" but cannot express
-- "QA has since re-inspected it", and it cannot distinguish a row that produced
-- a repeat from one that was replaced. Overloading it would make the slot
-- arithmetic below silently wrong the second time a piece bounces.
--
-- SLOT ARITHMETIC (the thing that must not drift)
-- ----------------------------------------------
-- A sheet has `repeats_count` physical slots. Each slot is held by exactly one
-- live thing:
--     a coded repeat, OR a damage row in (awaiting_return, awaiting_recheck,
--     written_off).
-- Rows in `passed` are excluded because the repeat they produced is already
-- counted; rows in `superseded` are excluded because their replacement is.
-- Counting either of those would double-count the slot and let a sheet report
-- more pieces than it physically has.
-- =============================================================================

alter table public.damage_records
  add column if not exists recheck_state text;

alter table public.damage_records drop constraint if exists damage_records_recheck_state_chk;
alter table public.damage_records add constraint damage_records_recheck_state_chk
  check (recheck_state is null or recheck_state in
    ('awaiting_return','awaiting_recheck','passed','superseded','written_off'));

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Rows on orders that have ALREADY moved past repeat QA are closed as
-- `written_off`: they were resolved under the old rule, and re-opening them
-- would drag finished orders back into QA's queue. Only orders still sitting at
-- `awaiting_coding` get live states.
-- ---------------------------------------------------------------------------
update public.damage_records d
   set recheck_state = case
         when o.status <> 'awaiting_coding'        then 'written_off'
         when d.ot_return_confirmed_at is not null then 'awaiting_recheck'
         else                                           'awaiting_return'
       end
  from public.orders o
 where o.id = d.order_id
   and d.stage_type = 'repeat_qa'
   and d.repeat_id is null
   and d.recheck_state is null;

create index if not exists idx_damage_repeat_qa_open
  on public.damage_records (sheet_id)
  where stage_type = 'repeat_qa' and repeat_id is null
    and recheck_state in ('awaiting_return','awaiting_recheck');

-- ---------------------------------------------------------------------------
-- Helper: how many of a sheet's slots are currently spoken for, and how many
-- are still stuck in the reject/return loop.
--
-- One definition, used by every function below, so the three of them cannot
-- disagree about what "resolved" means — which is exactly how 0034's bug got in.
-- ---------------------------------------------------------------------------
create or replace function public.sheet_piece_counts(p_sheet_id uuid)
returns table (coded int, held int, outstanding int)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from public.repeats r where r.sheet_id = p_sheet_id),
    (select count(*)::int from public.damage_records d
      where d.sheet_id = p_sheet_id and d.repeat_id is null
        and d.stage_type = 'repeat_qa'
        and coalesce(d.recheck_state,'awaiting_return')
              in ('awaiting_return','awaiting_recheck','written_off')),
    (select count(*)::int from public.damage_records d
      where d.sheet_id = p_sheet_id and d.repeat_id is null
        and d.stage_type = 'repeat_qa'
        and coalesce(d.recheck_state,'awaiting_return')
              in ('awaiting_return','awaiting_recheck'));
$$;

-- ---------------------------------------------------------------------------
-- 1. Pass a piece — unchanged behaviour, corrected slot count.
-- ---------------------------------------------------------------------------
create or replace function public.qa_pass_piece(
  p_order_id  uuid,
  p_sheet_id  uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_order  public.orders;
  v_sheet  public.sheets;
  v_repeat public.repeats;
  c        record;
  v_next   int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_photo_url is null or length(trim(p_photo_url)) = 0 then
    raise exception 'A photo is required to pass a piece.' using errcode = '22023';
  end if;

  select * into v_sheet from public.sheets
   where id = p_sheet_id and order_id = p_order_id;
  if not found then
    raise exception 'That sheet does not belong to this order.' using errcode = '22023';
  end if;

  select * into c from public.sheet_piece_counts(p_sheet_id);
  if c.coded + c.held >= v_sheet.repeats_count then
    raise exception 'Every piece on this sheet has already been inspected.' using errcode = '22023';
  end if;

  v_next := c.coded + 1;

  insert into public.repeats
    (factory_id, sheet_id, repeat_number, repeat_code, current_status)
  values
    (v_order.factory_id, p_sheet_id, v_next,
     v_order.order_code || '-S' || v_sheet.sheet_number || '-R' || lpad(v_next::text, 3, '0'),
     'coded')
  returning * into v_repeat;

  perform public.log_repeat_stage(
    v_repeat.id, 'coded', null, p_photo_url, 'Passed at initial QA'
  );

  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Reject a piece — now explicitly opens the return loop.
-- ---------------------------------------------------------------------------
create or replace function public.qa_reject_piece(
  p_order_id    uuid,
  p_sheet_id    uuid,
  p_damage_type text,
  p_photo_url   text,
  p_note        text default null,
  p_scope       text default 'piece'
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order     public.orders;
  v_sheet     public.sheets;
  c           record;
  v_remaining int;
  v_count     int;
  i           int;
  v_id        uuid;
  v_ids       uuid[] := '{}';
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_scope not in ('piece', 'sheet') then
    raise exception 'Invalid return scope.' using errcode = '22023';
  end if;

  select * into v_sheet from public.sheets
   where id = p_sheet_id and order_id = p_order_id;
  if not found then
    raise exception 'That sheet does not belong to this order.' using errcode = '22023';
  end if;

  select * into c from public.sheet_piece_counts(p_sheet_id);
  v_remaining := v_sheet.repeats_count - c.coded - c.held;

  if v_remaining <= 0 then
    raise exception 'Every piece on this sheet has already been inspected.' using errcode = '22023';
  end if;

  v_count := case when p_scope = 'sheet' then v_remaining else 1 end;

  for i in 1..v_count loop
    insert into public.damage_records
      (factory_id, order_id, sheet_id, repeat_id, stage_type, damage_type,
       responsible_type, responsible_id, photo_url, note, reported_by, recheck_state)
    values
      (v_order.factory_id, p_order_id, p_sheet_id, null, 'repeat_qa',
       p_damage_type, 'vendor', v_order.vendor_id, p_photo_url, p_note, auth.uid(),
       'awaiting_return')
    returning id into v_id;
    v_ids := array_append(v_ids, v_id);
  end loop;

  return jsonb_build_object('damage_ids', v_ids, 'count', v_count);
end $$;

-- ---------------------------------------------------------------------------
-- 3. The Order Taker's handback now hands the piece BACK TO QA.
--
-- Same physical event as before (0057) — the piece went to the vendor and the
-- vendor returned it — but it now moves the piece into QA's re-inspection
-- queue instead of simply being filed away.
-- ---------------------------------------------------------------------------
create or replace function public.ot_complete_qa_return(
  p_damage_id uuid,
  p_photo_url text default null,
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

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the piece handed back to the vendor is required.'
      using errcode = '22023';
  end if;

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
  if coalesce(v_damage.recheck_state, 'awaiting_return') <> 'awaiting_return' then
    raise exception 'This piece is not awaiting a return (state: %).',
      coalesce(v_damage.recheck_state, 'awaiting_return') using errcode = '22023';
  end if;

  update public.damage_records
     set ot_return_confirmed_at = now(),
         ot_return_note = p_note,
         ot_return_photo_url = p_photo_url,
         recheck_state = 'awaiting_recheck'
   where id = p_damage_id
  returning * into v_damage;

  return v_damage;
end $$;

-- ---------------------------------------------------------------------------
-- 4. QA re-inspects a returned piece. Pass codes it; reject restarts the loop.
-- ---------------------------------------------------------------------------
create or replace function public.qa_recheck_piece(
  p_damage_id   uuid,
  p_pass        boolean,
  p_photo_url   text,
  p_damage_type text default null,
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory  uuid := public.current_factory_id();
  v_damage   public.damage_records;
  v_order    public.orders;
  v_sheet    public.sheets;
  v_repeat   public.repeats;
  c          record;
  v_next     int;
  v_new_id   uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);

  select d.* into v_damage
    from public.damage_records d
   where d.id = p_damage_id
     and d.factory_id = v_factory
     and d.stage_type = 'repeat_qa'
     and d.repeat_id is null;
  if v_damage.id is null then
    perform public.raise_not_found('Rejected piece not found.');
  end if;

  if coalesce(v_damage.recheck_state, 'awaiting_return') <> 'awaiting_recheck' then
    raise exception 'This piece is not back from the vendor yet (state: %).',
      coalesce(v_damage.recheck_state, 'awaiting_return') using errcode = '22023';
  end if;
  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo is required to re-inspect a piece.' using errcode = '22023';
  end if;

  v_order := public.assert_my_order(v_damage.order_id);
  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;

  select * into v_sheet from public.sheets where id = v_damage.sheet_id;

  if p_pass then
    -- The slot this damage row held becomes a real coded repeat. Marking the
    -- row `passed` first is what stops it double-counting against the sheet.
    update public.damage_records set recheck_state = 'passed' where id = p_damage_id;

    select * into c from public.sheet_piece_counts(v_sheet.id);
    v_next := c.coded + 1;

    insert into public.repeats
      (factory_id, sheet_id, repeat_number, repeat_code, current_status)
    values
      (v_factory, v_sheet.id, v_next,
       v_order.order_code || '-S' || v_sheet.sheet_number || '-R' || lpad(v_next::text, 3, '0'),
       'coded')
    returning * into v_repeat;

    perform public.log_repeat_stage(
      v_repeat.id, 'coded', null, p_photo_url, 'Passed at initial QA after return'
    );

    return jsonb_build_object(
      'outcome', 'passed', 'damage_id', p_damage_id,
      'repeat_id', v_repeat.id, 'repeat_code', v_repeat.repeat_code
    );
  end if;

  -- Rejected again: hand the slot to a fresh row so the round trip repeats and
  -- the Order Taker sees a new active return. The old row is kept, superseded,
  -- so the piece's full bounce history stays readable.
  if coalesce(trim(p_damage_type), '') = '' then
    raise exception 'A damage reason is required to reject a piece.' using errcode = '22023';
  end if;

  update public.damage_records set recheck_state = 'superseded' where id = p_damage_id;

  insert into public.damage_records
    (factory_id, order_id, sheet_id, repeat_id, stage_type, damage_type,
     responsible_type, responsible_id, photo_url, note, reported_by, recheck_state)
  values
    (v_factory, v_order.id, v_sheet.id, null, 'repeat_qa',
     p_damage_type, 'vendor', v_order.vendor_id, p_photo_url, p_note, auth.uid(),
     'awaiting_return')
  returning id into v_new_id;

  return jsonb_build_object(
    'outcome', 'rejected', 'damage_id', p_damage_id, 'replacement_damage_id', v_new_id
  );
end $$;

-- ---------------------------------------------------------------------------
-- 5. "Continue to job card" now requires every piece to have PASSED.
--
-- This is the actual fix. A sheet is only clear when its coded repeats plus its
-- explicitly closed slots fill it AND nothing is still in the return loop.
-- ---------------------------------------------------------------------------
create or replace function public.qa_complete_repeat_qa(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_sheet record;
  c       record;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;

  for v_sheet in select * from public.sheets where order_id = p_order_id loop
    select * into c from public.sheet_piece_counts(v_sheet.id);

    if c.outstanding > 0 then
      raise exception
        'Sheet % has % piece(s) still in the return loop. A rejected piece has to go back to the vendor, be returned by the order taker, and pass QA again before this order can move on.',
        v_sheet.sheet_number, c.outstanding using errcode = '22023';
    end if;

    if c.coded + c.held < v_sheet.repeats_count then
      raise exception 'Sheet % still has pieces awaiting a decision.', v_sheet.sheet_number
        using errcode = '22023';
    end if;

    if c.coded = 0 then
      raise exception 'Sheet % has no passed pieces — there is nothing to produce.',
        v_sheet.sheet_number using errcode = '22023';
    end if;
  end loop;

  update public.orders set status = 'awaiting_job_card' where id = p_order_id
  returning * into v_order;

  return v_order;
end $$;

grant execute on function public.sheet_piece_counts(uuid) to authenticated;
grant execute on function public.qa_recheck_piece(uuid, boolean, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- NOTE ON `written_off` — read before assuming this is complete.
--
-- Nothing sets it. That is deliberate but it is also a live risk: if a vendor
-- never returns a rejected piece, the order stays at `awaiting_coding`
-- indefinitely and there is no in-app way to abandon the slot and proceed with
-- the pieces that did pass. The state exists so that adding a QA-only
-- "write off piece" action later is a small change rather than another
-- migration of the slot arithmetic. Flagged rather than built, because closing
-- a slot without a piece is a commercial decision, not a technical one.
-- ---------------------------------------------------------------------------
