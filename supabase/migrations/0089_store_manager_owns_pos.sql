-- =============================================================================
-- Factory ERP — the Store Manager owns purchase orders, in three statuses.
--
-- WHAT THIS REPLACES
-- ------------------
-- 0012/0013 gave a PO six live statuses and three owners:
--
--   auto_generated/draft -> executed -> awaiting_approval -> approved
--                        -> paid -> handed_over -> received
--     procurement ........^..........^
--     company_admin ..................^
--     accountant .............................^
--     procurement ...................................^
--
-- It is now three, with two owners:
--
--   Creation (auto_generated/draft) -> Procured -> Paid -> received
--     store manager ..................^
--     accountant .................................^
--
-- THE OWNER APPROVAL STEP IS REMOVED, not bypassed: `awaiting_approval` and
-- `approved` stop being reachable, `po_owner_approve` is dropped, and the PO
-- branch 0083 added to `owner_approvals_queue` is taken back out. Expenses,
-- damage deductions and bonus slabs keep their branches — only POs leave.
--
-- PROCUREMENT KEEPS READ ACCESS AND NOTHING ELSE. `po_execute`,
-- `po_upload_bill`, `po_owner_approve` and `po_handover_to_store` are dropped
-- rather than merely hidden: they are SECURITY DEFINER and were callable
-- straight over REST by anyone holding the role, so removing the buttons alone
-- would have left the transitions open.
--
-- WHO CREATES THE GRN NOW
-- -----------------------
-- `po_handover_to_store` was procurement's, and it was what put a PO's goods in
-- front of the store manager. With procurement read-only that press has no
-- owner, so the GRN is raised BY PAYMENT: `acct_record_payment` creates it in
-- the same transaction that marks the PO paid. Nobody has to remember a step
-- that only ever existed to say "the thing you paid for is on its way".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The status vocabulary
--
-- `procured` is added and the two approval statuses are left in the CHECK on
-- purpose: dropping them would fail against any historical row still holding
-- one, and section 2 migrates those rows rather than the constraint refusing
-- them. Nothing can WRITE those statuses any more — the only functions that
-- did are dropped below.
-- ---------------------------------------------------------------------------
alter table public.purchase_orders drop constraint if exists purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check
  check (status in (
    'auto_generated',      -- Creation: raised by the shortfall check
    'draft',               -- Creation: raised by hand
    'procured',            -- the store manager has bought it; with the accountant
    'paid',                -- the accountant has paid it; goods due in
    'received',            -- the store manager has checked the goods in (GRN)
    'cancelled',
    -- Retired. Retained so pre-0089 rows remain valid; unreachable from here.
    'executed', 'awaiting_approval', 'approved', 'handed_over'
  ));

alter table public.purchase_orders
  add column if not exists procured_at timestamptz,
  add column if not exists procured_by uuid references public.profiles(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 2. Migrate the POs already in flight
--
-- Everything between "bought" and "paid" collapses to `procured` — all three
-- old statuses mean the same thing under the new flow: the store manager has
-- committed to the purchase and the accountant has not yet paid. A PO stuck at
-- `awaiting_approval` is the important one: its owner-approval step no longer
-- exists, so without this it would wait forever for a screen that is gone.
-- ---------------------------------------------------------------------------
update public.purchase_orders
   set status = 'procured',
       procured_at = coalesce(procured_at, executed_at, created_at)
 where status in ('executed', 'awaiting_approval', 'approved');

-- `handed_over` meant "paid, and physically with the store". It keeps its GRN
-- (section 5 does not touch POs that already have one) and becomes `paid`,
-- which is what that state is called now.
update public.purchase_orders
   set status = 'paid'
 where status = 'handed_over';

-- ---------------------------------------------------------------------------
-- 3. Creation -> Procured, by the store manager
-- ---------------------------------------------------------------------------
create or replace function public.sm_mark_po_procured(p_po_id uuid, p_note text default null)
returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare po public.purchase_orders;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);
  po := public.assert_my_po(p_po_id);

  if po.status not in ('auto_generated','draft') then
    raise exception 'This purchase order is past Creation (status: %).', po.status
      using errcode = '22023';
  end if;
  if po.supplier_id is null then
    raise exception 'Assign a supplier before marking this procured.' using errcode = '22023';
  end if;

  update public.purchase_orders
     set status = 'procured',
         procured_at = now(),
         procured_by = auth.uid(),
         notes = coalesce(nullif(trim(p_note), ''), notes)
   where id = p_po_id
  returning * into po;

  return po;
end $$;

grant execute on function public.sm_mark_po_procured(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Procured -> Paid, by the accountant — and the GRN with it
--
-- Same signature as 0031's, so every existing caller keeps working. Two changes
-- inside: the PO must be `procured` (not `approved`, which nothing can reach
-- any more), and paying raises the goods-receipt note the store manager checks
-- the delivery in against.
-- ---------------------------------------------------------------------------
create or replace function public.acct_record_payment(
  p_ref_type  text,
  p_ref_id    uuid,
  p_amount    numeric,
  p_proof_url text default null,
  p_note      text default null
)
returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_pay     public.payments;
  v_dir     text;
  v_po      public.purchase_orders;
  v_grn     public.grns;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);
  perform public.assert_proof_photo(p_proof_url, 'A payment');

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Payment amount must be greater than zero.' using errcode = '22023';
  end if;

  if p_ref_type = 'invoice' then
    if not exists (select 1 from public.invoices
                    where id = p_ref_id and factory_id = v_factory) then
      perform public.raise_not_found('Invoice not found.');
    end if;
    v_dir := 'receivable';

  elsif p_ref_type = 'po' then
    select * into v_po from public.purchase_orders
     where id = p_ref_id and factory_id = v_factory;
    if not found then
      perform public.raise_not_found('Purchase order not found.');
    end if;
    -- Refused rather than silently recorded: the old version wrote the payment
    -- row whatever the PO's status was and only moved the PO if it happened to
    -- be `approved`, so paying too early left money posted against a PO that
    -- still read as unpaid.
    if v_po.status not in ('procured', 'approved') then
      raise exception
        'This purchase order is not with you yet (status: %). The store manager marks it Procured first.',
        v_po.status using errcode = '22023';
    end if;
    v_dir := 'payable';

  else
    raise exception 'Unsupported payment reference type: %.', p_ref_type using errcode = '22023';
  end if;

  insert into public.payments
    (factory_id, direction, ref_type, ref_id, amount, proof_url, recorded_by, note)
  values
    (v_factory, v_dir, p_ref_type, p_ref_id, p_amount, trim(p_proof_url), auth.uid(), p_note)
  returning * into v_pay;

  if p_ref_type = 'invoice' then
    update public.invoices set status = 'paid', paid_at = now() where id = p_ref_id;
  else
    update public.purchase_orders
       set status = 'paid', paid_at = now(), paid_by = auth.uid(),
           amount = coalesce(amount, p_amount)
     where id = p_ref_id;

    -- The goods-receipt note, raised by the payment. `po_handover_to_store` did
    -- this and belonged to procurement, who no longer act on POs at all.
    if not exists (
      select 1 from public.grns
       where purchase_order_id = p_ref_id and status <> 'rejected'
    ) then
      insert into public.grns
        (factory_id, grn_code, purchase_order_id, status, handed_over_by, note)
      values
        (v_factory,
         public.make_code(v_factory, 'GRN', public.next_counter(v_factory, 'grn_seq')),
         p_ref_id, 'pending', auth.uid(), 'Raised on payment')
      returning * into v_grn;

      -- Expected == ordered; the store manager may reduce received on a short
      -- delivery, exactly as before.
      insert into public.grn_items
        (factory_id, grn_id, color_code, description, expected_meters, received_meters)
      select v_factory, v_grn.id, i.color_code, i.description,
             i.quantity_meters, i.quantity_meters
      from public.po_items i
      where i.purchase_order_id = p_ref_id;
    end if;
  end if;

  return v_pay;
end $$;

grant execute on function public.acct_record_payment(text, uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Backfill: paid POs with no GRN
--
-- POs that reached `paid` (or `handed_over`, rewritten to `paid` above) before
-- this migration and never had a handover pressed. Nothing else will ever raise
-- their GRN, so the goods could not be checked in.
-- ---------------------------------------------------------------------------
do $$
declare
  po   record;
  v_id uuid;
begin
  for po in
    select * from public.purchase_orders p
     where p.status = 'paid'
       and not exists (select 1 from public.grns g
                        where g.purchase_order_id = p.id and g.status <> 'rejected')
  loop
    insert into public.grns
      (factory_id, grn_code, purchase_order_id, status, note)
    values
      (po.factory_id,
       public.make_code(po.factory_id, 'GRN', public.next_counter(po.factory_id, 'grn_seq')),
       po.id, 'pending', 'Raised by 0089 for a PO paid before the flow changed')
    returning id into v_id;

    insert into public.grn_items
      (factory_id, grn_id, color_code, description, expected_meters, received_meters)
    select po.factory_id, v_id, i.color_code, i.description,
           i.quantity_meters, i.quantity_meters
    from public.po_items i
    where i.purchase_order_id = po.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The accountant's payables list follows the new flow
--
-- `procured` only. It used to be "anything not paid/received/cancelled", which
-- under the new statuses would put POs the store manager has not even bought
-- yet in front of the accountant to pay.
-- ---------------------------------------------------------------------------
create or replace function public.acct_payable_suppliers()
returns table (
  po_id           uuid,
  po_code         text,
  supplier_id     uuid,
  supplier_name   text,
  status          text,
  amount          numeric,
  quantity_meters numeric,
  created_at      timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  select p.id, p.po_code, s.id, s.name, p.status, p.amount,
         coalesce((select sum(i.quantity_meters) from public.po_items i
                    where i.purchase_order_id = p.id), 0),
         p.created_at
  from public.purchase_orders p
  left join public.suppliers s on s.id = p.supplier_id
  where p.factory_id = v_factory
    and p.status = 'procured'
  order by p.created_at;
end $$;

grant execute on function public.acct_payable_suppliers() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The owner's inbox loses its PO branch
--
-- Byte-for-byte 0083's function with the fourth UNION removed. Expenses, damage
-- and bonus slabs are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.owner_approvals_queue()
returns table (
  kind        text,
  id          uuid,
  title       text,
  subtitle    text,
  amount      numeric,
  created_at  timestamptz
)
language sql stable security definer set search_path = public as $$
  select 'expense', e.id,
         initcap(replace(e.category, '_', ' ')),
         coalesce(e.description, 'No description'),
         e.amount, e.created_at
  from public.expenses e
  where e.factory_id = public.current_factory_id() and e.status = 'pending'

  union all

  select 'damage', d.id,
         initcap(d.damage_type) || ' — ' || d.responsible_type || ' accountable',
         coalesce((select order_code from public.orders o where o.id = d.order_id), '')
           || coalesce(' · ' || (select repeat_code from public.repeats r where r.id = d.repeat_id), ''),
         d.deduction, d.created_at
  from public.damage_records d
  where d.factory_id = public.current_factory_id() and d.approval_status = 'pending'

  union all

  select 'bonus_slab', p.id,
         'Bonus slab: ' || p.action,
         coalesce(p.reason, '') ||
           coalesce(' · ' || p.daily_stitch_threshold::text || ' stitches', '') ||
           coalesce(' -> ' || p.bonus_amount::text, ''),
         p.bonus_amount, p.created_at
  from public.bonus_slab_proposals p
  where p.factory_id = public.current_factory_id() and p.status = 'pending'

  -- 0083's 'purchase_order' branch was here. POs do not route through the owner
  -- any more: the store manager procures, the accountant pays.

  order by created_at
$$;

grant execute on function public.owner_approvals_queue() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Procurement's write transitions are removed
--
-- Dropped, not revoked. Each is SECURITY DEFINER and was reachable over REST by
-- anyone holding the role, so taking the buttons out of the app would have left
-- the transition callable by hand.
-- ---------------------------------------------------------------------------
drop function if exists public.po_execute(uuid);
drop function if exists public.po_upload_bill(uuid, text, numeric);
drop function if exists public.po_owner_approve(uuid, boolean);
drop function if exists public.po_handover_to_store(uuid, text);

-- ---------------------------------------------------------------------------
-- 9. Procurement's read-only PO list
--
-- Two buckets, matching the two tabs their dashboard becomes. Deliberately its
-- own function rather than reusing `sm_po_list`: that one is the store
-- manager's working list and carries the assignee they act on, and pointing a
-- read-only role at a writer's query is how the read-only role quietly grows
-- back its buttons.
-- ---------------------------------------------------------------------------
create or replace function public.proc_po_list(p_bucket text default 'pending')
returns table (
  id             uuid,
  po_code        text,
  status         text,
  supplier_name  text,
  order_code     text,
  line_count     int,
  total_quantity numeric,
  amount         numeric,
  created_at     timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['procurement','store_manager','company_admin']);

  if p_bucket not in ('pending','completed') then
    raise exception 'Unknown bucket: %.', p_bucket using errcode = '22023';
  end if;

  return query
  select po.id, po.po_code, po.status, s.name, o.order_code,
         (select count(*)::int from public.po_items pi where pi.purchase_order_id = po.id),
         (select coalesce(sum(pi.quantity_meters), 0) from public.po_items pi
           where pi.purchase_order_id = po.id),
         po.amount,
         po.created_at
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    left join public.orders    o on o.id = po.order_id
   where po.factory_id = v_factory
     and case p_bucket
           -- Pending = anything still owed money or goods.
           when 'pending' then po.status in ('auto_generated','draft','procured')
           -- Completed = paid for, whether or not the goods are checked in yet.
           else po.status in ('paid','received','cancelled')
         end
   order by po.created_at desc;
end $$;

grant execute on function public.proc_po_list(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Banners follow the transitions
--
-- Both functions are recreated from their 0087 bodies with two edits: the whole
-- procurement block is removed from my_queue_summary (that role has no
-- transitions left to prompt), and a `sm_po_procure` banner is added to the
-- store manager's block for POs still at Creation. my_queue_items loses the
-- three-status PO branch and gains the matching one.
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

    -- NEW. The store manager owns the PO lifecycle from 0089: a PO sitting at
    -- Creation is waiting on them to go and buy it. This banner is what the
    -- three procurement PO banners became — the work did not disappear, it
    -- changed hands.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status in ('auto_generated','draft');
    if n > 0 then
      return query select 'sm_po_procure', 'Purchase orders to procure', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to procure',
        'Buy it from the supplier, then mark it Procured to send it to the accountant',
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

  -- The three procurement PO banners (po_draft / po_bill / po_handover) were
  -- here. Procurement is read-only from 0089 — it has no PO transitions left to
  -- prompt, and a banner pointing at a button that no longer exists is worse
  -- than no banner. Their work moved to 'sm_po_procure' above and to the
  -- accountant's 'acct_payables'.
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
  if p_queue_key = 'sm_po_procure'
     and not (v_roles && array['store_manager','company_admin']) then return; end if;

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
  -- POs still at Creation, for the store manager who now owns them.
  elsif p_queue_key = 'sm_po_procure' then
    return query
    select po.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier assigned') || ' - ' ||
             (select count(*)::text from public.po_items pi where pi.purchase_order_id = po.id) || ' line(s)',
           po.order_id, null::text, po.id, po.status
      from public.purchase_orders po
      left join public.suppliers s on s.id = po.supplier_id
     where po.factory_id = v_factory
       and po.status in ('auto_generated','draft')
     order by po.created_at desc;
  end if;
end $$;

grant execute on function public.my_queue_summary() to authenticated;
grant execute on function public.my_queue_items(text) to authenticated;
