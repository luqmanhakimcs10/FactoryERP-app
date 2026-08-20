-- =============================================================================
-- Factory ERP — Order Taker timeline photos, and the QA simplification.
--
-- THREE CHANGES, ONE OF WHICH IS A REAL TRANSFER OF RESPONSIBILITY:
--
--   1. `order_timeline()` returns a PHOTO per step, so the Order Taker's
--      progress tracker shows the evidence at each stage instead of only its
--      status. Every photo comes from a column that already exists — nothing
--      new is captured, this only surfaces what is already stored.
--
--   2. Final QA becomes the Floor Manager's, alone. 0056 made it two gates
--      (`fm_final_qa_pass` -> awaiting_qa_final -> `qa_final_pass` -> completed).
--      QA is out of that step entirely now, so the Floor Manager's pass is what
--      COMPLETES a repeat, and it inherits the photo requirement 0062 put on
--      QA's gate — this is still the last look anyone takes before billing.
--
--   3. `qa_write_off_piece` keeps existing but loses its only caller.
--      See section 4 for why it is not dropped.
--
-- DRAINING THE IN-FLIGHT PIECES (this is the part that would otherwise strand
-- work): any repeat sitting at `awaiting_qa_final` when this runs was passed by
-- the Floor Manager and is waiting on a QA gate that no longer exists. Rather
-- than auto-completing them — which would fabricate a sign-off nobody gave —
-- both `fm_final_qa_queue` and `fm_final_qa_pass` are widened to accept that
-- status, so the Floor Manager sees them in their own queue and finishes them
-- properly, with a photo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. order_timeline: a photo per step
--
-- WHERE EACH PHOTO COMES FROM (all pre-existing columns):
--   captured     orders.cloth_photos[1]        the cloth the order taker shot
--   procurement  purchase_orders.bill_url      the supplier bill
--   inspection   damage_records.photo_url      the inspection finding, falling
--                                              back to the cloth photo when the
--                                              consignment was accepted clean
--   coding       repeat_stage_history.photo_url  the QA pass photo (0034)
--   job_card     orders.design_sheet_url       the design the card is built from
--   stage_N      repeat_stage_history.photo_url  newest evidence at that stage
--   delivery     orders.delivery_photo_url     proof of the handover
--
-- These are STORAGE PATHS in the private `order-photos` bucket, not URLs. The
-- screen resolves them to signed URLs exactly as it already does for the order's
-- own photo strip — returning a URL from SQL would bake an expiry into a cached
-- query result.
--
-- Adding a column to a RETURNS TABLE(...) is a return-type change, which
-- CREATE OR REPLACE refuses, so the old signature is dropped first.
-- ---------------------------------------------------------------------------
drop function if exists public.order_timeline(uuid);

create or replace function public.order_timeline(p_order_id uuid)
returns table (
  step_key  text,
  label     text,
  state     text,
  at        timestamptz,
  detail    text,
  photo_url text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_order    public.orders;
  v_total    int;
  v_coded_at timestamptz;
  v_coded    int;
  v_card     public.job_cards;
  v_ready_at timestamptz;
  v_ready    int;
  st         record;
  v_seen     int;
  v_cloth    text;
  v_inspect  text;
  v_codephoto text;
begin
  v_order := public.assert_my_order(p_order_id);

  select coalesce(sum(repeats_count), 0) into v_total
    from public.sheets where order_id = p_order_id;

  -- Coding: straight from history.
  select min(h.created_at), count(distinct h.repeat_id)
    into v_coded_at, v_coded
    from public.repeat_stage_history h
    join public.repeats rp on rp.id = h.repeat_id
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id and h.status = 'coded';

  select * into v_card from public.job_cards where order_id = p_order_id;

  select min(h.created_at), count(distinct h.repeat_id)
    into v_ready_at, v_ready
    from public.repeat_stage_history h
    join public.repeats rp on rp.id = h.repeat_id
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id and h.status = 'ready_for_production';

  -- The three photos that need a lookup rather than a column read.
  v_cloth := (select ph from unnest(coalesce(v_order.cloth_photos, '{}')) ph limit 1);

  select d.photo_url into v_inspect
    from public.damage_records d
   where d.order_id = p_order_id
     and d.stage_type = 'incoming_inspection'
     and d.photo_url is not null
   order by d.created_at desc
   limit 1;

  select h.photo_url into v_codephoto
    from public.repeat_stage_history h
    join public.repeats rp on rp.id = h.repeat_id
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id and h.status = 'coded' and h.photo_url is not null
   order by h.created_at desc
   limit 1;

  -- 1. Captured
  return query select
    'captured', 'Order captured',
    case when v_order.submitted_at is not null then 'done' else 'current' end,
    coalesce(v_order.submitted_at, v_order.created_at),
    -- Repeats only. `sheets` stays the internal row shape, but it is not a
    -- number the order taker ever asked for or can act on, and quoting both
    -- invited exactly the confusion this wording is fixing.
    v_total || ' repeat' || case when v_total = 1 then '' else 's' end || ' captured',
    v_cloth;

  -- 2. Procurement (only when the thread check found a shortfall)
  if v_order.status = 'awaiting_procurement'
     or exists (select 1 from public.purchase_orders where order_id = p_order_id) then
    return query select
      'procurement', 'Awaiting procurement',
      case when v_order.status = 'awaiting_procurement' then 'current' else 'done' end,
      (select min(created_at) from public.purchase_orders where order_id = p_order_id),
      (select string_agg(po_code, ', ') from public.purchase_orders where order_id = p_order_id),
      (select po.bill_url from public.purchase_orders po
        where po.order_id = p_order_id and po.bill_url is not null
        order by po.created_at desc limit 1);
  end if;

  -- 3. Inspection (pre-repeat: no history row exists to read)
  return query select
    'inspection', 'Cloth inspection',
    case
      when v_order.inspected_at is not null then 'done'
      when v_order.status = 'awaiting_cloth_inspection' then 'current'
      else 'ahead'
    end,
    v_order.inspected_at,
    (select case when count(*) > 0 then count(*) || ' damage record(s)' else null end
       from public.damage_records
      where order_id = p_order_id and responsible_type = 'vendor'),
    coalesce(v_inspect, v_cloth);

  -- 4. QA coding — from history
  return query select
    'coding', 'QA repeat coding',
    case
      when coalesce(v_coded, 0) >= v_total and v_total > 0 then 'done'
      when v_order.status = 'awaiting_coding' then 'current'
      when coalesce(v_coded, 0) > 0 then 'current'
      else 'ahead'
    end,
    v_coded_at,
    case when coalesce(v_coded,0) > 0
         then v_coded || ' of ' || v_total || ' repeats coded' else null end,
    v_codephoto;

  -- 5. Job card
  return query select
    'job_card', 'Job card',
    case
      when v_card.status = 'confirmed' then 'done'
      when v_card.status is not null then 'current'
      when v_order.status = 'awaiting_job_card' then 'current'
      else 'ahead'
    end,
    coalesce(v_card.confirmed_at, v_card.shared_at),
    case
      when v_card.status = 'confirmed' then 'Confirmed by vendor'
      when v_card.status = 'shared' then 'Shared, awaiting vendor'
      when v_card.status = 'draft' and v_card.change_notes is not null then 'Changes requested'
      when v_card.status = 'draft' then 'Draft'
      else null
    end,
    v_order.design_sheet_url;

  -- 6. Production + finishing: one step per configured stage, in sequence.
  for st in
    select os.*, row_number() over (order by os.sequence) as rn
      from public.order_stages os
     where os.order_id = p_order_id
     order by os.sequence
  loop
    select count(distinct h.repeat_id) into v_seen
      from public.repeat_stage_history h
     where h.order_stage_id = st.id;

    return query select
      'stage_' || st.sequence::text,
      initcap(st.stage_type) || case when st.is_outsourced then ' (outsourced)' else '' end,
      case
        when v_total > 0 and v_seen >= v_total and st.sequence = 1 and v_ready >= v_total then 'current'
        when v_seen = 0 then 'ahead'
        else 'current'
      end,
      (select min(created_at) from public.repeat_stage_history where order_stage_id = st.id),
      -- "reached" not "done": a repeat having a history row at this stage means it
      -- has arrived there, which is not the same as the stage being finished.
      case when v_seen > 0 then v_seen || ' of ' || v_total || ' repeats reached' else null end,
      -- The newest evidence anyone attached at this stage — a handover photo, a
      -- return photo, or a stage-QA pass, whichever happened last.
      (select h2.photo_url from public.repeat_stage_history h2
        where h2.order_stage_id = st.id and h2.photo_url is not null
        order by h2.created_at desc limit 1);
  end loop;

  -- 7. Delivery — always the tail of the sequence.
  return query select
    'delivery', 'Delivery to vendor',
    case
      when v_order.delivered_at is not null then 'done'
      when v_order.status = 'ready_for_delivery' then 'current'
      else 'ahead'
    end,
    v_order.delivered_at,
    case when v_order.delivered_at is not null then 'Handed to the vendor' else null end,
    v_order.delivery_photo_url;
end $$;

grant execute on function public.order_timeline(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Final QA is the Floor Manager's, and it completes the piece
--
-- `fm_final_qa_pass` gains a REQUIRED photo and a new signature, so the old
-- two-argument version must be dropped — PostgREST resolves overloads by
-- argument name, and leaving it in place would keep a no-photo, non-completing
-- final pass callable beside the real one.
-- ---------------------------------------------------------------------------
drop function if exists public.fm_final_qa_pass(uuid, text);

create or replace function public.fm_final_qa_pass(
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
  -- QA is deliberately NOT on this list any more. Final QA is the Floor
  -- Manager's step; QA's involvement ends at stage QA.
  perform public.assert_role(array['floor_manager', 'company_admin']);

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the finished product is required to pass final QA.'
      using errcode = '22023';
  end if;

  v_repeat := public.assert_my_repeat(p_repeat_id);

  -- `awaiting_qa_final` is accepted so pieces the Floor Manager had already
  -- passed to the retired QA gate can be finished here rather than stranded.
  if v_repeat.current_status not in ('awaiting_final_qa', 'awaiting_qa_final') then
    raise exception 'This repeat is not awaiting final QA (status: %).', v_repeat.current_status
      using errcode = '22023';
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

grant execute on function public.fm_final_qa_pass(uuid, text, text) to authenticated;

/**
 * The Floor Manager's queue now includes anything stuck at the retired QA gate,
 * so those pieces have somewhere to be finished from.
 */
create or replace function public.fm_final_qa_queue()
returns table (
  order_id      uuid,
  order_code    text,
  vendor_name   text,
  total_repeats int,
  ready_repeats int
)
language sql stable security definer set search_path = public as $$
  select o.id, o.order_code, v.name,
         count(r.id)::int,
         count(r.id) filter (
           where r.current_status in ('awaiting_final_qa','awaiting_qa_final'))::int
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  join public.sheets s on s.order_id = o.id
  join public.repeats r on r.sheet_id = s.id
  where o.factory_id = public.current_factory_id()
    and not exists (select 1 from public.invoices i
                     where i.order_id = o.id and i.status <> 'cancelled')
  group by o.id, o.order_code, v.name
  having count(r.id) filter (
    where r.current_status in ('awaiting_final_qa','awaiting_qa_final')) > 0
  order by o.order_code
$$;

grant execute on function public.fm_final_qa_queue() to authenticated;

-- QA's final gate is gone. Dropped rather than left callable: a SECURITY
-- DEFINER function that completes a repeat is not something to leave on the
-- REST surface after deciding the role that calls it should not do this.
drop function if exists public.qa_final_pass(uuid, text, text);
drop function if exists public.qa_final_pass(uuid, text);
drop function if exists public.qa_final_queue();

-- ---------------------------------------------------------------------------
-- 3. Complete Return stays restricted to the order's creator
--
-- Nothing to change: `ot_complete_return` (0036) and `ot_complete_qa_return`
-- (0059) already compare `orders.created_by` to `auth.uid()` and raise
-- not-found for anyone else, and `ot_return_repeats` never lists another order
-- taker's rows in the first place. This comment is the record that it was
-- checked against two live logins rather than assumed — see
-- scripts/verify-return-ownership.mjs.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Write Off: caller removed, function kept
--
-- The "Write off" control is gone from QA's reject flow. `qa_write_off_piece`
-- is deliberately NOT dropped, because it is the only thing that can close a
-- rejected piece the vendor never sends back — without a caller, an order with
-- one such piece now sits at `awaiting_coding` indefinitely. Keeping the
-- function means that escape can be given to another role later without a
-- schema change; dropping it would destroy the capability along with the button.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. Banners: QA loses its final-pass queue, the Floor Manager's widens
--
-- Both functions are recreated from their 0086 bodies with three edits:
--   - the `qa_final` block is removed from my_queue_summary;
--   - `qa_final` is removed from my_queue_items' guard and its branch;
--   - `fm_final_qa` counts and lists BOTH awaiting_final_qa and
--     awaiting_qa_final, so the drained pieces are visible to the role that now
--     owns them.
-- Nothing else in either body is changed.
-- ---------------------------------------------------------------------------

create or replace function public.my_queue_summary()
returns table (
  queue_key       text,
  label           text,
  count           int,
  banner_title    text,
  banner_subtitle text,
  own_task        boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_role    text   := public.current_user_role();

  v_roles   text[] := public.effective_roles();
  v_uid     uuid := auth.uid();
  v_partner uuid;
  n         int;
begin
  if v_factory is null or v_role is null then
    return;   -- super admin / unlinked user has no per-factory queue
  end if;

  if v_roles && array['floor_manager', 'company_admin'] then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared');
    if n > 0 then
      return query select 'awaiting_job_card', 'Orders awaiting a job card', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a job card',
        'Set the stage sequence so production can be planned',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.material_issues mi
     where mi.factory_id = v_factory and mi.accepted_at is null;
    if n > 0 then
      return query select 'accept_inventory', 'Material ready to accept', n,
        n || ' order' || case when n = 1 then '' else 's' end || ' ready to accept material',
        'Materials are waiting in the store — accept to start production',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_fm_collection';
    if n > 0 then
      return query select 'fm_collect', 'Pieces back from delivery', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' waiting to be collected',
        'The delivery person has handed these back — confirm you have them',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handover_for_delivery';
    if n > 0 then
      return query select 'fm_handover', 'Stages ready to hand over', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to hand over',
        'Passed stage QA — hand to the delivery person',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory
       and r.current_status in ('awaiting_final_qa','awaiting_qa_final');
    if n > 0 then
      return query select 'fm_final_qa', 'Awaiting your final QA', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' final QA',
        'The last check before the piece is billed and delivered',
        ('floor_manager' = any(v_roles));
    end if;

    -- NEW — the dashboard's "Shift close" card already counts these. Same
    -- predicate as fm_shift_close_queue(), inlined behind module_enabled so a
    -- factory without machine_workforce gets no row instead of an exception.
    -- `managed_by is null` is in the original and is kept: an unassigned machine
    -- is everyone's to close, not nobody's.
    if public.module_enabled('machine_workforce') then
      select count(*) into n
        from public.shifts s
        join public.machines m on m.id = s.machine_id
       where s.factory_id = v_factory
         and s.status = 'open'
         and (('company_admin' = any(v_roles)) or m.managed_by = v_uid or m.managed_by is null);
      if n > 0 then
        return query select 'fm_shift_close', 'Shifts still open', n,
          n || ' shift' || case when n = 1 then '' else 's' end || ' still open',
          'Close each one to record stitches and pay the worker',
          ('floor_manager' = any(v_roles));
      end if;
    end if;

    -- NEW — the dashboard's "Leave" card already counts these.
    select count(*) into n from public.leaves l
     where l.factory_id = v_factory and l.status = 'pending';
    if n > 0 then
      return query select 'fm_leave', 'Leave requests', n,
        n || ' leave request' || case when n = 1 then '' else 's' end || ' to decide',
        'A worker is waiting on your approval',
        ('floor_manager' = any(v_roles));
    end if;

    -- Finished orders whose leftover material is still signed out to the floor.
    -- The Orders box grew a "Handover" tab for this and its count had no banner.
    select count(*) into n
      from public.orders o
     where o.factory_id = v_factory
       and o.status <> 'cancelled'
       and (o.status in ('ready_for_delivery','completed')
            or public.fm_floor_is_finished(o.id))
       and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
       and not exists (select 1 from public.fm_handovers h where h.order_id = o.id);
    if n > 0 then
      return query select 'fm_store_handover', 'Material to hand back', n,
        n || ' order' || case when n = 1 then '' else 's' end
          || case when n = 1 then ' needs' else ' need' end || ' material handed back',
        'Log what is left over so it goes back into store stock',
        ('floor_manager' = any(v_roles));
    end if;

    -- The automatic "stock was already here" notice. 0069 addresses it to the
    -- FLOOR MANAGER, and nothing was surfacing it to them.
    select count(*) into n
      from public.material_requests mr
     where mr.factory_id = v_factory
       and mr.origin = 'auto_stock_ready'
       and mr.directed_to = 'floor_manager'
       and mr.status = 'pending';
    if n > 0 then
      return query select 'fm_material_ready', 'Material ready in the store', n,
        n || ' order' || case when n = 1 then '' else 's' end
          || case when n = 1 then ' has' else ' have' end || ' material ready',
        'Everything these need is already in stock - collect it when you are ready',
        ('floor_manager' = any(v_roles));
    end if;
  end if;

  if v_roles && array['store_manager', 'company_admin'] then
    select count(*) into n from public.job_cards jc
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id);
    if n > 0 then
      return query select 'material_requests', 'Material requests', n,
        n || ' material request' || case when n = 1 then '' else 's' end || ' waiting',
        'The floor cannot start production until these are issued',
        ('store_manager' = any(v_roles));
    end if;

    select count(*) into n from public.grns g
     where g.factory_id = v_factory and g.status = 'pending';
    if n > 0 then
      return query select 'grn_pending', 'Deliveries to confirm', n,
        n || ' deliver' || case when n = 1 then 'y' else 'ies' end || case when n = 1 then ' needs' else ' need' end || ' checking in',
        'Confirm what actually arrived against the purchase order',
        ('store_manager' = any(v_roles));
    end if;

    -- A count of one outstanding obligation rather than of rows, so it is 1 or
    -- absent. The brief calls the daily audit mandatory; the Audit tab already
    -- flags it, and this puts the same flag where the role actually starts.
    if not exists (
      select 1 from public.stock_audits sa
       where sa.factory_id = v_factory and sa.audit_type = 'daily'
         and sa.audit_date = current_date
    ) then
      return query select 'sm_audit_today', 'Daily audit not done', 1,
        'Today''s stock audit has not been done',
        'Count every item once a day so the ledger stays trustworthy',
        ('store_manager' = any(v_roles));
    end if;
  end if;

  if v_roles && array['qa', 'company_admin'] then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_cloth_inspection','awaiting_coding');
    if n > 0 then
      return query select 'qa_inspection', 'Orders awaiting inspection', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' inspection',
        'Check the cloth, then code each piece',
        ('qa' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'stage_qa';
    if n > 0 then
      return query select 'qa_stage', 'Stage QA waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' stage QA',
        'Pass or mark damage before the stage can move on',
        ('qa' = any(v_roles));
    end if;
  end if;

  if v_roles && array['delivery', 'company_admin'] then
    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_dp_collection'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_collect', 'Pieces to collect', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect',
        'Collect from the floor manager — a photo is required',
        ('delivery' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_over'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_send', 'Pieces to send out', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to send out',
        'Take these to the finishing partner the floor manager chose',
        ('delivery' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and r.partner_ready_at is not null
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_pickup', 'Finished at the partner', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect back',
        'The finishing partner says these are done',
        ('delivery' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'returned_to_delivery'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_handback', 'Pieces to hand back', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' to hand back',
        'Return these to the floor manager',
        ('delivery' = any(v_roles));
    end if;

    -- NEW — the "Ready for final delivery" section on the delivery person's own
    -- Orders screen already lists these (9 in Alpha), and it is the last leg of
    -- the job: every stage is through QA and the order goes back to the client.
    -- Same predicate as dp_final_delivery_queue().
    if public.module_enabled('order_lifecycle') then
      select count(*) into n
        from public.orders o
       where o.factory_id = v_factory
         and o.status in ('ready_for_delivery','job_card_confirmed','in_production','in_finishing')
         and not exists (
           select 1 from public.repeats r
           join public.sheets s on s.id = r.sheet_id
           where s.order_id = o.id
             and r.current_status not in ('awaiting_final_qa','completed')
         );
      if n > 0 then
        return query select 'dp_final_delivery', 'Ready for final delivery', n,
          n || ' order' || case when n = 1 then '' else 's' end || ' ready for final delivery',
          'Every stage is through QA — these go back to the client',
          ('delivery' = any(v_roles));
      end if;
    end if;
  end if;

  if ('finishing_partner' = any(v_roles)) then
    select fp.id into v_partner from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;
    if v_partner is not null then
      select count(*) into n from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'handed_off'
         and r.current_partner_id = v_partner and r.partner_ready_at is null;
      if n > 0 then
        return query select 'partner_active', 'Work with you now', n,
          n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' your work',
          'Mark each one finished when you are done with it',
        true;
      end if;
    end if;
  end if;

  if v_roles && array['order_taker', 'company_admin'] then
    select count(*) into n
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (('company_admin' = any(v_roles)) or o.created_by = v_uid);
    if n > 0 then
      return query select 'ot_returns', 'Returns to complete', n,
        n || ' return' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' completing',
        'Photograph each piece as it goes back to the vendor',
        ('order_taker' = any(v_roles));
    end if;
  end if;

  if v_roles && array['accountant', 'company_admin'] then
    select count(*) into n from public.invoices i
     where i.factory_id = v_factory and i.status = 'pending';
    if n > 0 then
      return query select 'acct_receivables', 'Unpaid invoices', n,
        n || ' invoice' || case when n = 1 then '' else 's' end || ' unpaid',
        'Money owed to the factory — record payment when it arrives',
        ('accountant' = any(v_roles));
    end if;

    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'approved';
    if n > 0 then
      return query select 'acct_payables', 'Bills awaiting payment', n,
        n || ' bill' || case when n = 1 then '' else 's' end || ' waiting to be paid',
        'Approved and due — settle and record the payment',
        ('accountant' = any(v_roles));
    end if;
  end if;

  if ('company_admin' = any(v_roles)) then
    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'pending';
    if n > 0 then
      return query select 'owner_approvals', 'Approvals waiting on you', n,
        n || ' approval' || case when n = 1 then '' else 's' end || ' waiting on you',
        'Nothing moves on these until you decide',
        true;
    end if;
  end if;

  if v_roles && array['procurement', 'company_admin'] then
    -- `auto_generated` (raised automatically on a stock shortfall) and `draft`
    -- are both pre-execution.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status in ('auto_generated','draft');
    if n > 0 then
      return query select 'po_draft', 'Purchase orders to raise', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to raise',
        'Auto-raised on a stock shortfall — assign a supplier and send',
        ('procurement' = any(v_roles));
    end if;

    -- NEW — `executed` and `paid` both sit in the PO screen's "To action"
    -- filter, and both have a button on PoDetail waiting to be pressed. They are
    -- two SEPARATE banners, not one, because they ask for two different things:
    -- upload a bill, versus confirm a physical handover. Merging them would put
    -- the user back to opening the list to find out which.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status = 'executed';
    if n > 0 then
      return query select 'po_bill', 'Supplier bills to upload', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a supplier bill',
        'Sent to the supplier — upload the bill to send it for approval',
        ('procurement' = any(v_roles));
    end if;

    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status = 'paid';
    if n > 0 then
      return query select 'po_handover', 'Purchase orders to hand over', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to hand over',
        'Paid — confirm handover so the store can check the goods in',
        ('procurement' = any(v_roles));
    end if;
  end if;
end $$;

create or replace function public.my_queue_items(p_queue_key text)
returns table (
  item_id      uuid,
  code         text,
  title        text,
  subtitle     text,
  order_id     uuid,
  order_code   text,
  secondary_id uuid,
  status       text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_role    text   := public.current_user_role();

  v_roles   text[] := public.effective_roles();
  v_uid     uuid := auth.uid();
  v_partner uuid;
begin
  if v_factory is null or v_role is null then
    return;
  end if;

  -- A queue key is not a capability. Asking for another role's queue returns
  -- NOTHING rather than raising, so a stale client requesting a key it no
  -- longer owns degrades to an empty list instead of an error screen.
  if p_queue_key in ('awaiting_job_card','accept_inventory','fm_collect','fm_handover',
                     'fm_final_qa','fm_shift_close','fm_leave')
     and not (v_roles && array['floor_manager','company_admin']) then return; end if;
  if p_queue_key in ('fm_store_handover','fm_material_ready')
     and not (v_roles && array['floor_manager','company_admin']) then return; end if;
  if p_queue_key in ('material_requests','grn_pending')
     and not (v_roles && array['store_manager','company_admin']) then return; end if;
  if p_queue_key in ('qa_inspection','qa_stage')
     and not (v_roles && array['qa','company_admin']) then return; end if;
  if p_queue_key in ('dp_collect','dp_send','dp_pickup','dp_handback','dp_final_delivery')
     and not (v_roles && array['delivery','company_admin']) then return; end if;
  if p_queue_key = 'partner_active' and not ('finishing_partner' = any(v_roles)) then return; end if;
  if p_queue_key = 'ot_returns' and not (v_roles && array['order_taker','company_admin']) then return; end if;
  if p_queue_key in ('acct_receivables','acct_payables')
     and not (v_roles && array['accountant','company_admin']) then return; end if;
  if p_queue_key = 'owner_approvals' and not ('company_admin' = any(v_roles)) then return; end if;
  if p_queue_key in ('po_draft','po_bill','po_handover')
     and not (v_roles && array['procurement','company_admin']) then return; end if;

  -- ---- Floor Manager -----------------------------------------------------
  if p_queue_key = 'awaiting_job_card' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(*)::text from public.sheets s where s.order_id = o.id) || ' sheet(s)',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared')
     order by o.created_at;

  elsif p_queue_key = 'accept_inventory' then
    return query
    select mi.id, o.order_code, o.order_code,
           'Issued by the store - ' || to_char(mi.created_at, 'DD Mon'),
           o.id, o.order_code, mi.id, 'pending'::text
      from public.material_issues mi
      join public.orders o on o.id = mi.order_id
     where mi.factory_id = v_factory and mi.accepted_at is null
     order by mi.created_at;

  elsif p_queue_key in ('fm_collect','fm_handover','fm_final_qa') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '), 'final'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory
       -- A CASE returning a STATUS cannot express the final-QA branch, which
       -- now matches two of them. Returning the BOOLEAN from each branch can.
       -- (The earlier shape would have yielded NULL for fm_final_qa, so the row
       --  test was never true and the queue came back empty.)
       and case p_queue_key
             when 'fm_collect'  then r.current_status = 'awaiting_fm_collection'
             when 'fm_handover' then r.current_status = 'handover_for_delivery'
             else r.current_status in ('awaiting_final_qa','awaiting_qa_final')
           end
     order by o.created_at, r.repeat_code;

  -- NEW. secondary_id is the shift, which is what ShiftClose opens on.
  elsif p_queue_key = 'fm_shift_close' then
    if not public.module_enabled('machine_workforce') then return; end if;
    return query
    select s.id, m.name, m.name,
           coalesce(wp.display_name, 'Unassigned') || ' - open since ' ||
             to_char(s.opened_at, 'DD Mon HH24:MI'),
           s.order_id, o.order_code, s.id, s.status
      from public.shifts s
      join public.machines m on m.id = s.machine_id
      left join public.profiles wp on wp.id = s.worker_id
      left join public.orders o on o.id = s.order_id
     where s.factory_id = v_factory
       and s.status = 'open'
       and (('company_admin' = any(v_roles)) or m.managed_by = v_uid or m.managed_by is null)
     order by m.name;

  -- NEW. Approve/reject is inline on the Leave box, so there is no per-item
  -- screen — the app routes the whole banner there rather than to a list that
  -- cannot be tapped through from.
  elsif p_queue_key = 'fm_leave' then
    return query
    select l.id, coalesce(wp.display_name, 'Worker'), coalesce(wp.display_name, 'Worker'),
           to_char(l.start_date, 'DD Mon') || ' to ' || to_char(l.end_date, 'DD Mon') ||
             ' - ' || l.reason,
           null::uuid, null::text, l.id, l.status
      from public.leaves l
      left join public.profiles wp on wp.id = l.worker_id
     where l.factory_id = v_factory and l.status = 'pending'
     order by l.requested_at;

  elsif p_queue_key = 'fm_store_handover' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(distinct mii.color_code)::text
                from public.material_issues mi2
                join public.material_issue_items mii on mii.material_issue_id = mi2.id
               where mi2.order_id = o.id) || ' item(s) issued',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status <> 'cancelled'
       and (o.status in ('ready_for_delivery','completed')
            or public.fm_floor_is_finished(o.id))
       and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
       and not exists (select 1 from public.fm_handovers h where h.order_id = o.id)
     order by o.updated_at desc;

  elsif p_queue_key = 'fm_material_ready' then
    return query
    select mr.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ready since ' || to_char(mr.requested_at, 'DD Mon'),
           o.id, o.order_code, mr.id, mr.status
      from public.material_requests mr
      join public.orders o on o.id = mr.order_id
      left join public.vendors v on v.id = o.vendor_id
     where mr.factory_id = v_factory
       and mr.origin = 'auto_stock_ready'
       and mr.directed_to = 'floor_manager'
       and mr.status = 'pending'
     order by mr.requested_at;

  -- ---- Store Manager -----------------------------------------------------
  elsif p_queue_key = 'material_requests' then
    return query
    select jc.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - confirmed ' || to_char(jc.confirmed_at, 'DD Mon'),
           o.id, o.order_code, jc.id, jc.status
      from public.job_cards jc
      join public.orders o on o.id = jc.order_id
      left join public.vendors v on v.id = o.vendor_id
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id)
     order by jc.confirmed_at;

  elsif p_queue_key = 'grn_pending' then
    return query
    select g.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier') || ' - raised ' || to_char(po.created_at,'DD Mon'),
           po.order_id, null::text, g.id, g.status
      from public.grns g
      join public.purchase_orders po on po.id = g.purchase_order_id
      left join public.suppliers s on s.id = po.supplier_id
     where g.factory_id = v_factory and g.status = 'pending'
     order by g.created_at;

  -- ---- QA ----------------------------------------------------------------
  elsif p_queue_key = 'qa_inspection' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             case when o.status = 'awaiting_cloth_inspection'
                  then 'check the cloth' else 'code the pieces' end,
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status in ('awaiting_cloth_inspection','awaiting_coding')
     order by o.created_at;

  elsif p_queue_key = 'qa_stage' then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '), 'stage QA'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory
       and r.current_status = 'stage_qa'
     order by o.created_at, r.repeat_code;

  -- ---- Delivery ----------------------------------------------------------
  elsif p_queue_key in ('dp_collect','dp_send','dp_pickup','dp_handback') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '),'stage')
             || coalesce(' - ' || fp.name, ''),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
      left join public.finishing_partners fp on fp.id = r.current_partner_id
     where r.factory_id = v_factory
       and public.dp_sees_repeat(r.current_delivery_id)
       and case p_queue_key
             when 'dp_collect'  then r.current_status = 'awaiting_dp_collection'
             when 'dp_send'     then r.current_status = 'handed_over'
             when 'dp_pickup'   then r.current_status = 'handed_off' and r.partner_ready_at is not null
             else                    r.current_status = 'returned_to_delivery' end
     order by r.updated_at desc;

  -- NEW. Whole orders, not repeats — the final leg is delivered per order.
  elsif p_queue_key = 'dp_final_delivery' then
    if not public.module_enabled('order_lifecycle') then return; end if;
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(*)::text from public.repeats r
               join public.sheets s on s.id = r.sheet_id
              where s.order_id = o.id) || ' piece(s), all through QA',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status in ('ready_for_delivery','job_card_confirmed','in_production','in_finishing')
       and not exists (
         select 1 from public.repeats r
         join public.sheets s on s.id = r.sheet_id
         where s.order_id = o.id
           and r.current_status not in ('awaiting_final_qa','completed')
       )
     order by o.created_at;

  -- ---- Finishing Partner -------------------------------------------------
  elsif p_queue_key = 'partner_active' then
    select fp.id into v_partner from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;
    if v_partner is null then return; end if;
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '),'stage'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and r.current_partner_id = v_partner and r.partner_ready_at is null
     order by r.updated_at desc;

  -- ---- Order Taker -------------------------------------------------------
  elsif p_queue_key = 'ot_returns' then
    return query
    select d.id, o.order_code, o.order_code,
           'Rejected at QA - ' || replace(d.damage_type,'_',' '),
           o.id, o.order_code, d.id, coalesce(d.recheck_state,'awaiting_return')
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (('company_admin' = any(v_roles)) or o.created_by = v_uid)
     order by d.created_at;

  -- ---- Accountant / Owner ------------------------------------------------
  elsif p_queue_key = 'acct_receivables' then
    return query
    select i.id, i.invoice_code, i.invoice_code,
           coalesce(v.name, '-') || ' - ' || to_char(i.amount, 'FM999,999,990.00'),
           i.order_id, o.order_code, i.id, i.status
      from public.invoices i
      left join public.orders o on o.id = i.order_id
      left join public.vendors v on v.id = o.vendor_id
     where i.factory_id = v_factory and i.status = 'pending'
     order by i.created_at;

  elsif p_queue_key in ('acct_payables','owner_approvals') then
    return query
    select e.id,
           initcap(replace(e.category,'_',' ')),
           initcap(replace(e.category,'_',' ')),
           coalesce(e.description,'No description') || ' - ' || to_char(e.amount,'FM999,999,990.00'),
           null::uuid, null::text, e.id, e.status
      from public.expenses e
     where e.factory_id = v_factory
       and e.status = case p_queue_key when 'acct_payables' then 'approved' else 'pending' end
     order by e.created_at;

  -- ---- Procurement -------------------------------------------------------
  -- One branch, three statuses: the row shape and destination (PoDetail) are
  -- identical, only the predicate differs.
  elsif p_queue_key in ('po_draft','po_bill','po_handover') then
    return query
    select po.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier assigned') || ' - ' ||
             (select count(*)::text from public.po_items pi where pi.purchase_order_id = po.id) || ' line(s)',
           po.order_id, null::text, po.id, po.status
      from public.purchase_orders po
      left join public.suppliers s on s.id = po.supplier_id
     where po.factory_id = v_factory
       and case p_queue_key
             when 'po_draft'  then po.status in ('auto_generated','draft')
             when 'po_bill'   then po.status = 'executed'
             else                  po.status = 'paid' end
     order by po.created_at desc;
  end if;
end $$;

grant execute on function public.my_queue_summary() to authenticated;
grant execute on function public.my_queue_items(text) to authenticated;
