-- =============================================================================
-- Factory ERP — Front-of-dashboard task banners.
--
-- WHAT THIS IS, AND WHAT IT IS NOT
-- -------------------------------
-- This is a SURFACING layer. It adds no business logic, no status transitions
-- and no new state. Every row it returns is read straight out of the same
-- tables the role's own screens already read, with the same role and factory
-- guards. If a queue here disagreed with the screen it points at, the screen
-- would be right — so both are driven from the same predicates, written once.
--
-- TWO FUNCTIONS
-- -------------
--   my_queue_summary()          — extended, not replaced. It already backed the
--                                 notification bell (queue_key/label/count);
--                                 it now also carries the banner's plain-language
--                                 title and subtitle. One source of truth means
--                                 the bell and the banner can never disagree.
--
--   my_queue_items(queue_key)   — the rows behind one banner, so tapping it opens
--                                 exactly that queue rather than a general
--                                 section the user then has to search.
--
-- WORDING
-- -------
-- Titles are deliberately plain: "3 orders need a job card", not "3 orders at
-- awaiting_job_card". The people using this on a factory floor should not have
-- to learn the state machine's vocabulary to understand what is being asked of
-- them. Counts are pluralised in SQL because the banner renders the string
-- verbatim.
--
-- ROUTING IS NOT IN HERE
-- ----------------------
-- These functions return WHAT is pending, never WHERE to go. The screen name
-- and params for each queue live in the app (`taskQueues.ts`), because
-- navigation is the client's concern and a route name in the database would be
-- a migration every time a screen is renamed.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Summary — bell counts AND banner copy, from one definition.
--
-- `own_task` separates "this is YOUR job" from "you can see this".
-- company_admin is deliberately in almost every role's count list, because the
-- owner supervises all of it — correct for the notification bell. It is wrong
-- for banners: an owner would open the app to NINE stacked act-now banners and
-- the one thing actually waiting on them (approvals) would be lost in the pile,
-- which is the exact clutter this feature exists to remove. So the bell keeps
-- counting everything, and the banners render only `own_task` rows.
-- ---------------------------------------------------------------------------
drop function if exists public.my_queue_summary();

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
  v_role    text := public.current_user_role();
  v_uid     uuid := auth.uid();
  v_partner uuid;
  n         int;
  /** "1 order" / "3 orders" — the banner prints this straight out. */
  function_placeholder text;
begin
  if v_factory is null or v_role is null then
    return;   -- super admin / unlinked user has no per-factory queue
  end if;

  if v_role in ('floor_manager', 'company_admin') then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared');
    if n > 0 then
      return query select 'awaiting_job_card', 'Orders awaiting a job card', n,
        n || ' order' || case when n = 1 then '' else 's' end || ' need a job card',
        'Set the stage sequence so production can be planned',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.material_issues mi
     where mi.factory_id = v_factory and mi.accepted_at is null;
    if n > 0 then
      return query select 'accept_inventory', 'Material ready to accept', n,
        n || ' order' || case when n = 1 then '' else 's' end || ' ready to accept material',
        'Materials are waiting in the store — accept to start production',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_fm_collection';
    if n > 0 then
      return query select 'fm_collect', 'Pieces back from delivery', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' waiting to be collected',
        'The delivery person has handed these back — confirm you have them',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handover_for_delivery';
    if n > 0 then
      return query select 'fm_handover', 'Stages ready to hand over', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to hand over',
        'Passed stage QA — hand to the delivery person',
        v_role = 'floor_manager';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_final_qa';
    if n > 0 then
      return query select 'fm_final_qa', 'Awaiting your final QA', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' need final QA',
        'Check each one before it goes to QA for the final pass',
        v_role = 'floor_manager';
    end if;
  end if;

  if v_role in ('store_manager', 'company_admin') then
    select count(*) into n from public.job_cards jc
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id);
    if n > 0 then
      return query select 'material_requests', 'Material requests', n,
        n || ' material request' || case when n = 1 then '' else 's' end || ' waiting',
        'The floor cannot start production until these are issued',
        v_role = 'store_manager';
    end if;

    select count(*) into n from public.grns g
     where g.factory_id = v_factory and g.status = 'pending';
    if n > 0 then
      return query select 'grn_pending', 'Deliveries to confirm', n,
        n || ' deliver' || case when n = 1 then 'y' else 'ies' end || ' need checking in',
        'Confirm what actually arrived against the purchase order',
        v_role = 'store_manager';
    end if;
  end if;

  if v_role in ('qa', 'company_admin') then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_cloth_inspection','awaiting_coding');
    if n > 0 then
      return query select 'qa_inspection', 'Orders awaiting inspection', n,
        n || ' order' || case when n = 1 then '' else 's' end || ' need inspection',
        'Check the cloth, then code each piece',
        v_role = 'qa';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'stage_qa';
    if n > 0 then
      return query select 'qa_stage', 'Stage QA waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' need stage QA',
        'Pass or mark damage before the stage can move on',
        v_role = 'qa';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_qa_final';
    if n > 0 then
      return query select 'qa_final', 'Final pass waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' need a final pass',
        'Photograph the finished product and pass it',
        v_role = 'qa';
    end if;
  end if;

  if v_role in ('delivery', 'company_admin') then
    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_dp_collection';
    if n > 0 then
      return query select 'dp_collect', 'Pieces to collect', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect',
        'Collect from the floor manager — a photo is required',
        v_role = 'delivery';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_over';
    if n > 0 then
      return query select 'dp_send', 'Pieces to send out', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to send out',
        'Choose who is handling the stage and hand it over',
        v_role = 'delivery';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and r.partner_ready_at is not null;
    if n > 0 then
      return query select 'dp_pickup', 'Finished at the partner', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect back',
        'The finishing partner says these are done',
        v_role = 'delivery';
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'returned_to_delivery';
    if n > 0 then
      return query select 'dp_handback', 'Pieces to hand back', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' to hand back',
        'Return these to the floor manager',
        v_role = 'delivery';
    end if;
  end if;

  if v_role = 'finishing_partner' then
    select fp.id into v_partner from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;
    if v_partner is not null then
      select count(*) into n from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'handed_off'
         and r.current_partner_id = v_partner and r.partner_ready_at is null;
      if n > 0 then
        return query select 'partner_active', 'Work with you now', n,
          n || ' piece' || case when n = 1 then '' else 's' end || ' need your work',
          'Mark each one finished when you are done with it',
        true;
      end if;
    end if;
  end if;

  if v_role in ('order_taker', 'company_admin') then
    select count(*) into n
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (v_role = 'company_admin' or o.created_by = v_uid);
    if n > 0 then
      return query select 'ot_returns', 'Returns to complete', n,
        n || ' return' || case when n = 1 then '' else 's' end || ' need completing',
        'Photograph each piece as it goes back to the vendor',
        v_role = 'order_taker';
    end if;
  end if;

  if v_role in ('accountant', 'company_admin') then
    select count(*) into n from public.invoices i
     where i.factory_id = v_factory and i.status = 'pending';
    if n > 0 then
      return query select 'acct_receivables', 'Unpaid invoices', n,
        n || ' invoice' || case when n = 1 then '' else 's' end || ' unpaid',
        'Money owed to the factory — record payment when it arrives',
        v_role = 'accountant';
    end if;

    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'approved';
    if n > 0 then
      return query select 'acct_payables', 'Bills awaiting payment', n,
        n || ' bill' || case when n = 1 then '' else 's' end || ' waiting to be paid',
        'Approved and due — settle and record the payment',
        v_role = 'accountant';
    end if;
  end if;

  if v_role = 'company_admin' then
    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'pending';
    if n > 0 then
      return query select 'owner_approvals', 'Approvals waiting on you', n,
        n || ' approval' || case when n = 1 then '' else 's' end || ' waiting on you',
        'Nothing moves on these until you decide',
        true;
    end if;
  end if;

  if v_role in ('procurement', 'company_admin') then
    -- `auto_generated` (raised automatically on a stock shortfall) and `draft`
    -- are both pre-execution. `draft` alone was wrong: this factory has 37
    -- auto_generated POs and zero drafts, so the banner never appeared.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status in ('auto_generated','draft');
    if n > 0 then
      return query select 'po_draft', 'Purchase orders to raise', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to raise',
        'Auto-raised on a stock shortfall — assign a supplier and send',
        v_role = 'procurement';
    end if;
  end if;
end $$;

grant execute on function public.my_queue_summary() to authenticated;
