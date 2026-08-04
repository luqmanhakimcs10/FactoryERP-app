-- =============================================================================
-- Factory ERP — Partner dashboard repair + Active Work, per-role queue counts,
-- delivery sort order, and a photo on QA's final pass.
--
-- FIX 3a — THREE BROKEN FUNCTIONS, NOT ONE
-- ----------------------------------------
-- The reported "structure of query does not match function result type" was
-- real, but probing the partner dashboard's four RPCs found three failures:
--
--   partner_get_completed_work  42804  "Returned type bigint does not match
--                                       expected type integer in column 6"
--     -> sum(jcl.stitch_count) is bigint; the column is declared int. Cast it.
--
--   partner_get_damage_charges  42702  "column reference id is ambiguous"
--   partner_get_payment_history 42702  same
--     -> Both declare an OUT column named `id` in RETURNS TABLE, which puts a
--        PL/pgSQL variable called `id` in scope for the whole body. Their
--        `select id into v_partner_id from finishing_partners` then cannot tell
--        the out-param from the table column. Fixed by aliasing the table and
--        qualifying the reference (fp.id) rather than by renaming the output,
--        which would break the client's field names.
--
-- Only `partner_get_earnings_summary` worked, which is why the dashboard showed
-- the Net Receivable card and then an error underneath it.
--
-- FIX 3b — ACTIVE WORK
-- --------------------
-- A stage is "with this partner" when the repeat is `handed_off` (0056) and
-- `current_partner_id` is them. That state already exists and needs no new
-- machinery to read.
--
-- The partner's "Handover to delivery person" sets `partner_ready_at`. It is
-- deliberately a SIGNAL, not a gate: `dp_collect_from_partner` still works
-- without it. Making it a hard precondition would read truer to the wording,
-- but it would also mean a partner who never presses the button can strand a
-- piece at their premises with no in-app way for the factory to retrieve it.
-- The Delivery Person sees the flag and sorts by it instead.
--
-- FIX 5 — QUEUE COUNTS FOR THE NOTIFICATION BELL
-- ----------------------------------------------
-- `my_queue_summary()` counts what is WAITING ON THE CALLER right now, per
-- role, entirely from the tables each role's dashboard already reads. No new
-- business logic, no events table, no triggers.
--
-- It counts "currently waiting" rather than "new since you last looked". That
-- is a deliberate choice: unread-tracking needs a per-user seen-state table and
-- gets subtly wrong whenever two people share a role or an item is actioned
-- elsewhere. A pending count still rises the moment new work lands — which is
-- what the bell is for — and can never be stale or lie.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FIX 3a.1 — bigint vs int
-- ---------------------------------------------------------------------------
create or replace function public.partner_get_completed_work(p_period text default null)
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_code       text,
  stage_type       text,
  completed_at     timestamptz,
  stitch_count     int,
  earning_amount   numeric
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_partner_id uuid;
  v_period text := coalesce(p_period, to_char(now() at time zone 'UTC', 'YYYY-MM'));
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','accountant','floor_manager','company_admin']);

  select fp.id into v_partner_id
    from public.finishing_partners fp
   where fp.user_id = auth.uid()
     and fp.factory_id = public.current_factory_id()
     and fp.deleted_at is null;

  if v_partner_id is null then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select r.id, r.repeat_code, o.order_code, st.stage_type,
         rsh.returned_at,
         case when st.stage_type = 'embroidery' then
           coalesce((
             select sum(jcl.stitch_count)
               from public.job_cards jc
               join public.job_card_lines jcl on jcl.job_card_id = jc.id
              where jc.order_id = o.id
           ), 0)::int          -- sum() is bigint; the column is int.
         else 0 end,
         pl.amount
    from public.partner_ledger pl
    join public.repeats r on r.id = pl.repeat_id
    join public.sheets sh on sh.id = r.sheet_id
    join public.orders o on o.id = sh.order_id
    join public.order_stages st on st.id = (
      select rsh2.order_stage_id
        from public.repeat_stage_history rsh2
       where rsh2.repeat_id = r.id
         and rsh2.returned_at is not null
       order by rsh2.returned_at desc
       limit 1
    )
    left join public.repeat_stage_history rsh on rsh.repeat_id = r.id
      and rsh.order_stage_id = st.id
      and rsh.returned_at is not null
   where pl.factory_id = public.current_factory_id()
     and pl.partner_id = v_partner_id
     and pl.entry_type = 'earning'
     and pl.period = v_period
   order by pl.created_at desc;
end $$;

-- ---------------------------------------------------------------------------
-- FIX 3a.2 / 3a.3 — the out-param `id` shadowing the table column
-- ---------------------------------------------------------------------------
create or replace function public.partner_get_damage_charges(p_period text default null)
returns table (
  id                uuid,
  repeat_code       text,
  order_code        text,
  stage_type        text,
  damage_type       text,
  amount            numeric,
  photo_url         text,
  note              text,
  created_at        timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_partner_id uuid;
  v_period text := coalesce(p_period, to_char(now() at time zone 'UTC', 'YYYY-MM'));
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','accountant','floor_manager','company_admin']);

  -- `fp.` qualified: an unqualified `id` here resolves to this function's own
  -- OUT column, not the table's.
  select fp.id into v_partner_id
    from public.finishing_partners fp
   where fp.user_id = auth.uid()
     and fp.factory_id = public.current_factory_id()
     and fp.deleted_at is null;

  if v_partner_id is null then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select pl.id, r.repeat_code, o.order_code, dr.stage_type,
         dr.damage_type, pl.amount, dr.photo_url, dr.note, pl.created_at
    from public.partner_ledger pl
    join public.damage_records dr on dr.id = pl.damage_record_id
    join public.repeats r on r.id = dr.repeat_id
    join public.sheets sh on sh.id = r.sheet_id
    join public.orders o on o.id = sh.order_id
   where pl.factory_id = public.current_factory_id()
     and pl.partner_id = v_partner_id
     and pl.entry_type = 'damage_charge'
     and pl.period = v_period
   order by pl.created_at desc;
end $$;

create or replace function public.partner_get_payment_history()
returns table (
  id          uuid,
  amount      numeric,
  period      text,
  created_at  timestamptz,
  created_by_name text
)
language plpgsql stable security definer set search_path = public as $$
declare v_partner_id uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','accountant','floor_manager','company_admin']);

  select fp.id into v_partner_id
    from public.finishing_partners fp
   where fp.user_id = auth.uid()
     and fp.factory_id = public.current_factory_id()
     and fp.deleted_at is null;

  if v_partner_id is null then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select pl.id, pl.amount, pl.period, pl.created_at, pr.display_name
    from public.partner_ledger pl
    left join public.profiles pr on pr.id = pl.created_by
   where pl.factory_id = public.current_factory_id()
     and pl.partner_id = v_partner_id
     and pl.entry_type = 'payment'
   order by pl.created_at desc;
end $$;

-- ---------------------------------------------------------------------------
-- FIX 3b — Active work, and the partner's "done" signal.
-- ---------------------------------------------------------------------------
alter table public.repeats
  add column if not exists partner_ready_at timestamptz;

create or replace function public.partner_active_work()
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  vendor_name      text,
  sheet_number     int,
  color_assignment text,
  order_stage_id   uuid,
  stage_type       text,
  stage_sequence   int,
  total_stages     int,
  sla_hours        int,
  handed_off_at    timestamptz,
  sla_breached     boolean,
  partner_ready_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_partner_id uuid;
  v_factory    uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','delivery','floor_manager','company_admin']);

  select fp.id into v_partner_id
    from public.finishing_partners fp
   where fp.user_id = auth.uid()
     and fp.factory_id = v_factory
     and fp.deleted_at is null;

  if v_partner_id is null then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  return query
  select
    r.id, r.repeat_code, o.id, o.order_code, coalesce(v.name, '—'),
    sh.sheet_number, sh.color_assignment,
    st.id, st.stage_type, st.sequence,
    (select count(*)::int from public.order_stages os where os.order_id = o.id),
    st.sla_hours,
    leg.handed_off_at,
    exists (select 1 from public.sla_alerts a
             where a.repeat_id = r.id and a.resolved_at is null),
    r.partner_ready_at
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  left join public.vendors v on v.id = o.vendor_id
  left join public.order_stages st
         on st.order_id = o.id and st.sequence = greatest(r.current_stage_index, 1)
  left join lateral (
    select h.handed_off_at
      from public.repeat_stage_history h
     where h.repeat_id = r.id and h.handed_off_at is not null and h.returned_at is null
     order by h.handed_off_at desc
     limit 1
  ) leg on true
  where r.factory_id = v_factory
    -- "With this partner and not yet returned" is exactly `handed_off` (0056).
    and r.current_status = 'handed_off'
    and r.current_partner_id = v_partner_id
  order by leg.handed_off_at desc nulls last, r.repeat_code;
end $$;

/**
 * The partner marks their work finished. A SIGNAL to the delivery person, not a
 * gate — see this file's header for why `dp_collect_from_partner` deliberately
 * still works without it.
 */
create or replace function public.partner_ready_for_collection(p_repeat_id uuid)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_partner_id uuid;
  v_repeat     public.repeats;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['finishing_partner','company_admin']);

  select fp.id into v_partner_id
    from public.finishing_partners fp
   where fp.user_id = auth.uid()
     and fp.factory_id = public.current_factory_id()
     and fp.deleted_at is null;

  if v_partner_id is null then
    perform public.raise_not_found('Partner profile not linked to this user.');
  end if;

  v_repeat := public.assert_my_repeat(p_repeat_id);

  -- A partner may only act on a piece that is physically theirs.
  if v_repeat.current_partner_id is distinct from v_partner_id
     and public.current_user_role() <> 'company_admin' then
    perform public.raise_not_found('Repeat not found.');
  end if;
  if v_repeat.current_status <> 'handed_off' then
    raise exception 'This piece is not currently with you (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;

  update public.repeats
     set partner_ready_at = now(), updated_at = now()
   where id = p_repeat_id
  returning * into v_repeat;

  -- Audit trail: the history table is the record of who did what, and a partner
  -- saying "this is finished" is a real event even though custody has not moved.
  insert into public.repeat_stage_history
    (factory_id, repeat_id, order_stage_id, status, actor_user_id, note)
  select v_repeat.factory_id, p_repeat_id,
         (select os.id from public.order_stages os
            join public.sheets s2 on s2.id = v_repeat.sheet_id
           where os.order_id = s2.order_id
             and os.sequence = greatest(v_repeat.current_stage_index, 1)),
         'handed_off', auth.uid(), 'Finishing partner marked work complete';

  return v_repeat;
end $$;

-- Clear the signal when the piece actually comes back, so a later stage with
-- the same partner does not start out looking finished.
create or replace function public.dp_collect_from_partner(
  p_repeat_id uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_repeat public.repeats;
  st       public.order_stages;
  v_hist   uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'handed_off' then
    raise exception 'This repeat is not out at a finishing partner (status: %).', v_repeat.current_status
      using errcode = '22023';
  end if;
  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A collection photo is required.' using errcode = '22023';
  end if;

  st := public.repeat_current_stage(p_repeat_id);

  select id into v_hist
    from public.repeat_stage_history
   where repeat_id = p_repeat_id
     and handed_off_at is not null
     and returned_at is null
   order by handed_off_at desc
   limit 1;

  if v_hist is not null then
    update public.repeat_stage_history
       set returned_at = now(), return_photo_url = p_photo_url
     where id = v_hist;
  end if;

  update public.sla_alerts
     set resolved_at = now()
   where repeat_id = p_repeat_id and order_stage_id = st.id and resolved_at is null;

  update public.repeats
     set dp_returned_photo_url = p_photo_url,
         partner_ready_at = null     -- the signal belonged to this leg only
   where id = p_repeat_id;

  perform public.log_repeat_stage(p_repeat_id, 'returned_to_delivery', st.id, p_photo_url,
    'Collected back from finishing partner');

  select * into v_repeat from public.repeats where id = p_repeat_id;
  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- FIX 4 — Delivery Person's list: newest first, urgency still wins.
--
-- Only the ORDER BY changes. Breached SLA items stay pinned to the top — a
-- piece that is already late matters more than one that just arrived — and
-- within each group the newest work now leads instead of trailing.
-- ---------------------------------------------------------------------------
-- Two columns are being added to the result, which is a return-type change;
-- CREATE OR REPLACE refuses those, so the old signature must go first.
drop function if exists public.dp_orders_queue();

create or replace function public.dp_orders_queue()
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_id         uuid,
  order_code       text,
  vendor_name      text,
  sheet_number     int,
  color_assignment text,
  order_stage_id   uuid,
  stage_type       text,
  stage_sequence   int,
  total_stages     int,
  current_status   text,
  partner_id       uuid,
  partner_name     text,
  sla_hours        int,
  handed_off_at    timestamptz,
  sla_breached     boolean,
  arrived_at       timestamptz,
  partner_ready_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['delivery', 'company_admin']);

  return query
  select
    r.id, r.repeat_code, o.id, o.order_code, coalesce(v.name, '—'),
    sh.sheet_number, sh.color_assignment,
    st.id, st.stage_type, st.sequence,
    (select count(*)::int from public.order_stages os where os.order_id = o.id),
    r.current_status,
    r.current_partner_id, fp.name, st.sla_hours,
    lastleg.handed_off_at,
    coalesce(
      exists (select 1 from public.sla_alerts a
               where a.repeat_id = r.id and a.resolved_at is null),
      false),
    -- When this piece last became the delivery person's problem. `updated_at`
    -- moves on every transition, which is precisely "when it arrived in my
    -- queue in its current state".
    r.updated_at,
    r.partner_ready_at
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  left join public.vendors v on v.id = o.vendor_id
  left join public.order_stages st
         on st.order_id = o.id and st.sequence = greatest(r.current_stage_index, 1)
  left join public.finishing_partners fp on fp.id = r.current_partner_id
  left join lateral (
    select h.handed_off_at
      from public.repeat_stage_history h
     where h.repeat_id = r.id and h.handed_off_at is not null and h.returned_at is null
     order by h.handed_off_at desc
     limit 1
  ) lastleg on true
  where r.factory_id = v_factory
    and r.current_status in (
      'awaiting_dp_collection', 'handed_over', 'handed_off', 'returned_to_delivery'
    )
  order by
    (exists (select 1 from public.sla_alerts a
              where a.repeat_id = r.id and a.resolved_at is null)) desc,
    -- Partner says it is finished -> next most urgent.
    (r.partner_ready_at is not null) desc,
    r.updated_at desc,          -- FIX 4: newest first
    r.repeat_code;
end $$;

-- ---------------------------------------------------------------------------
-- QA's final pass now requires a photo of the finished product.
--
-- Consistent with every other custody/quality checkpoint in the app, all of
-- which already demand evidence. This is the last look anyone takes at the
-- piece before it is billed and delivered, so it is the worst place to have no
-- record of what was approved.
-- ---------------------------------------------------------------------------
drop function if exists public.qa_final_pass(uuid, text);

create or replace function public.qa_final_pass(
  p_repeat_id uuid,
  p_photo_url text,
  p_note      text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_repeat   public.repeats;
  v_order_id uuid;
  v_pending  int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa', 'company_admin']);

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the finished product is required to pass final QA.'
      using errcode = '22023';
  end if;

  v_repeat := public.assert_my_repeat(p_repeat_id);

  if v_repeat.current_status <> 'awaiting_qa_final' then
    raise exception 'This repeat has not cleared the Floor Manager''s final QA (status: %).',
      v_repeat.current_status using errcode = '22023';
  end if;

  perform public.log_repeat_stage(p_repeat_id, 'completed', null, p_photo_url,
    coalesce(p_note, 'Passed final QA'));

  select s.order_id into v_order_id from public.sheets s where s.id = v_repeat.sheet_id;

  select count(*) into v_pending
    from public.repeats r
    join public.sheets s on s.id = r.sheet_id
   where s.order_id = v_order_id
     and r.current_status not in ('completed', 'damaged');

  if v_pending = 0 then
    update public.orders
       set status = 'ready_for_delivery', updated_at = now()
     where id = v_order_id and status <> 'completed';
  end if;

  return jsonb_build_object(
    'repeat_id', p_repeat_id, 'status', 'completed', 'order_ready', v_pending = 0
  );
end $$;

grant execute on function public.partner_active_work() to authenticated;
grant execute on function public.partner_ready_for_collection(uuid) to authenticated;
grant execute on function public.qa_final_pass(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- FIX 5 — what is waiting on the caller, per role.
--
-- One read, no writes, no new tables and no triggers: every number below comes
-- from a table the role's own dashboard already reads. That is the whole point
-- of the brief's "notification layer on top of state changes that already
-- happen" — nothing here can desynchronise from the real queues, because it IS
-- the real queues.
--
-- Returns zero rows for a role with nothing pending, so the bell simply shows
-- no badge. Never raises: a notification bell must not be able to break the
-- header it lives in.
-- ---------------------------------------------------------------------------
create or replace function public.my_queue_summary()
returns table (
  queue_key text,
  label     text,
  count     int
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_role    text := public.current_user_role();
  v_uid     uuid := auth.uid();
  v_partner uuid;
begin
  if v_factory is null or v_role is null then
    return;   -- super admin / unlinked user: nothing is queued for them
  end if;

  if v_role in ('floor_manager', 'company_admin') then
    return query
      select 'awaiting_job_card', 'Orders awaiting a job card',
             count(*)::int from public.orders o
       where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared')
      having count(*) > 0;

    return query
      select 'accept_inventory', 'Material ready to accept',
             count(*)::int from public.material_issues mi
       where mi.factory_id = v_factory and mi.accepted_at is null
      having count(*) > 0;

    return query
      select 'fm_collect', 'Pieces back from delivery',
             count(*)::int from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'awaiting_fm_collection'
      having count(*) > 0;

    return query
      select 'fm_final_qa', 'Awaiting your final QA',
             count(*)::int from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'awaiting_final_qa'
      having count(*) > 0;
  end if;

  if v_role in ('store_manager', 'company_admin') then
    return query
      select 'material_requests', 'Material requests',
             count(*)::int from public.job_cards jc
       where jc.factory_id = v_factory
         and jc.status = 'confirmed'
         and jc.material_requested_at is not null
         and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id)
      having count(*) > 0;
  end if;

  if v_role in ('qa', 'company_admin') then
    return query
      select 'qa_inspection', 'Orders awaiting inspection',
             count(*)::int from public.orders o
       where o.factory_id = v_factory
         and o.status in ('awaiting_cloth_inspection','awaiting_coding')
      having count(*) > 0;

    return query
      select 'qa_stage', 'Stage QA waiting',
             count(*)::int from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'stage_qa'
      having count(*) > 0;

    return query
      select 'qa_final', 'Final pass waiting',
             count(*)::int from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'awaiting_qa_final'
      having count(*) > 0;
  end if;

  if v_role in ('delivery', 'company_admin') then
    return query
      select 'dp_orders', 'Pieces to move',
             count(*)::int from public.repeats r
       where r.factory_id = v_factory
         and r.current_status in ('awaiting_dp_collection','handed_over','handed_off','returned_to_delivery')
      having count(*) > 0;
  end if;

  if v_role = 'finishing_partner' then
    select fp.id into v_partner
      from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;

    if v_partner is not null then
      return query
        select 'partner_active', 'Work with you now',
               count(*)::int from public.repeats r
         where r.factory_id = v_factory
           and r.current_status = 'handed_off'
           and r.current_partner_id = v_partner
        having count(*) > 0;
    end if;
  end if;

  if v_role in ('order_taker', 'company_admin') then
    return query
      select 'ot_returns', 'Returns to complete',
             count(*)::int
        from public.damage_records d
        join public.orders o on o.id = d.order_id
       where d.factory_id = v_factory
         and d.stage_type = 'repeat_qa'
         and d.repeat_id is null
         and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
         and (v_role = 'company_admin' or o.created_by = v_uid)
      having count(*) > 0;
  end if;

  if v_role in ('accountant', 'company_admin') then
    return query
      select 'acct_receivables', 'Unpaid invoices',
             count(*)::int from public.invoices i
       where i.factory_id = v_factory and i.status = 'pending'
      having count(*) > 0;

    return query
      select 'acct_payables', 'Bills awaiting payment',
             count(*)::int from public.expenses e
       where e.factory_id = v_factory and e.status = 'approved'
      having count(*) > 0;
  end if;

  if v_role = 'company_admin' then
    return query
      select 'owner_approvals', 'Approvals waiting on you',
             count(*)::int from public.expenses e
       where e.factory_id = v_factory and e.status = 'pending'
      having count(*) > 0;
  end if;

  if v_role in ('procurement', 'company_admin') then
    return query
      select 'po_draft', 'Purchase orders to raise',
             count(*)::int from public.purchase_orders po
       where po.factory_id = v_factory and po.status = 'draft'
      having count(*) > 0;
  end if;
end $$;

grant execute on function public.my_queue_summary() to authenticated;
